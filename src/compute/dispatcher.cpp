// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/compute/dispatcher.hpp"

#include "dstns/compute/cpu_backend.hpp"
#include "dstns/compute/vulkan.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <sstream>

namespace dstns::compute {
namespace {
using namespace physics;
using Clock = std::chrono::steady_clock;

double ms_since(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

std::uint32_t modules_of(const StepRequest& r) {
    return (r.traffic ? MOD_TRAFFIC : 0u) | (r.signals ? MOD_SIGNALS : 0u) |
           (r.buildings ? MOD_BUILDINGS : 0u) | (r.flooding ? MOD_FLOODING : 0u);
}

double median(std::vector<double> values) {
    if (values.empty()) return 0;
    std::sort(values.begin(), values.end());
    return values[values.size() / 2];
}

nlohmann::json capabilities_json(const ComputeCapabilities& c) {
    return {
        {"name", c.name}, {"vendor", c.vendor}, {"vendor_id", c.vendor_id}, {"device_id", c.device_id},
        {"type", c.device_type}, {"api_version", c.api_version}, {"driver", c.driver},
        {"driver_version", c.driver_version}, {"uuid", c.uuid}, {"memory_bytes", c.device_memory_bytes},
        {"hardware_accelerated", c.hardware_accelerated}, {"software", !c.hardware_accelerated},
        {"moltenvk", c.moltenvk}, {"portability_subset", c.portability_subset},
        {"timestamps", c.timestamps}, {"synchronization2", c.synchronization2},
        {"validation", c.validation}, {"unified_memory", c.unified_memory},
        {"compute_queue_family", c.queue_family}, {"workgroup_size", c.workgroup_size},
        {"threads", c.threads}, {"pipeline_cache", c.pipeline_cache}, {"shader_bundle", c.shader_bundle},
        {"deterministic", c.deterministic}
    };
}
} // namespace

ComputeDispatcher::ComputeDispatcher(ComputeOptions options, LogSink log)
    : options_(std::move(options)), log_(std::move(log)) {
    cpu_ = std::make_unique<CpuComputeBackend>(options_.cpu_threads);
    if (options_.backend == BackendPreference::Cpu || !options_.allow_vulkan) {
        vulkan_health_ = BackendHealth::Disabled;
        vulkan_reason_ = options_.backend == BackendPreference::Cpu ? "the CPU backend was requested"
                                                                     : "Vulkan is disabled by configuration";
    } else if (!vulkan_compiled()) {
        vulkan_reason_ = "this build does not include the Vulkan backend";
    }
}

ComputeDispatcher::~ComputeDispatcher() {
    // Orderly teardown: wait for the device, free the world's resources, then
    // let the backend destroy its device and instance.
    if (vulkan_) {
        try {
            vulkan_->synchronize();
            vulkan_->release();
        } catch (...) {
        }
    }
}

void ComputeDispatcher::log(const std::string& level, const std::string& message) const {
    if (log_) log_(level, message);
}

void ComputeDispatcher::initialize() {
    if (vulkan_initialized_) return;
    vulkan_initialized_ = true;
    if (vulkan_health_ == BackendHealth::Disabled) return;
    const auto wanted = options_.backend == BackendPreference::Vulkan;
    if (!vulkan_compiled()) {
        vulkan_health_ = BackendHealth::Unavailable;
        if (wanted && options_.require_vulkan) throw std::runtime_error("Vulkan is required, but " + vulkan_reason_);
        return;
    }
    std::string reason;
    const auto started = Clock::now();
    vulkan_ = create_vulkan_backend(options_, log_, reason);
    if (!vulkan_) {
        vulkan_health_ = BackendHealth::Unavailable;
        vulkan_reason_ = reason;
        log(wanted ? "WARN" : "INFO", "compute.backend.unavailable vulkan: " + reason);
        if (wanted && options_.require_vulkan) throw std::runtime_error("Vulkan is required, but it is unavailable: " + reason);
        return;
    }
    vulkan_health_ = BackendHealth::Available;
    vulkan_reason_.clear();
    const auto caps = vulkan_->capabilities();
    std::ostringstream out;
    out << "compute.backend.detected vulkan device=\"" << caps.name << "\" driver=\"" << caps.driver << ' ' << caps.driver_version
        << "\" api=" << caps.api_version << " workgroup=" << caps.workgroup_size
        << (caps.moltenvk ? " via=MoltenVK" : "") << " in " << std::lround(ms_since(started)) << " ms";
    log("INFO", out.str());
}

void ComputeDispatcher::release() {
    if (!installed_) return;
    if (vulkan_) {
        try {
            vulkan_->synchronize();
            vulkan_->release();
        } catch (const ComputeError& e) {
            fail_vulkan(e.what());
        }
    }
    cpu_->release();
    installed_ = false;
    active_ = BackendType::Cpu;
    tables_ = {};
    state_.clear();
    shadow_state_.clear();
    shadow_inputs_.clear();
    journal_.clear();
    patches_.clear();
    selection_reason_ = "no world installed";
}

void ComputeDispatcher::install(const Scenario& scenario) {
    release();
    tables_ = build_static_tables(scenario);
    state_ = initial_state(tables_);
    host_complete_ = true;
    inputs_.reset(tables_);
    patches_.clear();
    overrides_.assign(tables_.node_count, 0);
    override_nodes_.clear();
    needs_recovery_ = false;
    calibration_ = {};
    cpu_->install(tables_);
    installed_ = true;
    active_ = BackendType::Cpu;
    choose_backend();
    take_shadow();
}

void ComputeDispatcher::choose_backend() {
    const auto& t = tables_;
    const auto size = std::to_string(t.node_count) + " nodes, " + std::to_string(t.edge_count) + " edges";
    if (vulkan_health_ == BackendHealth::Disabled) {
        selection_reason_ = vulkan_reason_;
    } else if (options_.backend == BackendPreference::Auto && t.node_count < options_.min_nodes && t.edge_count < options_.min_edges) {
        selection_reason_ = "the world (" + size + ") is below the accelerator threshold; the CPU is faster at this size";
    } else {
        initialize();
        if (!vulkan_ || vulkan_health_ == BackendHealth::Failed || vulkan_health_ == BackendHealth::Unavailable) {
            selection_reason_ = "Vulkan is unavailable: " + vulkan_reason_;
        } else {
            try {
                vulkan_->install(tables_);
                vulkan_->upload_state(state_);
                inputs_.request_full_upload();
                if (options_.backend == BackendPreference::Auto && options_.calibrate) calibrate();
                if (vulkan_health_ != BackendHealth::Failed && (!calibration_.ran || calibration_.chosen == "vulkan")) {
                    active_ = BackendType::Vulkan;
                    vulkan_health_ = BackendHealth::Active;
                    selection_reason_ = options_.backend == BackendPreference::Vulkan
                                            ? "Vulkan was requested"
                                            : "measured faster than the CPU on this world (" + size + ")";
                } else if (vulkan_health_ != BackendHealth::Failed) {
                    vulkan_->release();
                    vulkan_health_ = BackendHealth::Available;
                    selection_reason_ = "measured: the CPU is faster on this world (" + size + ")";
                }
            } catch (const ComputeError& e) {
                // The device cannot hold this world, or failed setting it up.
                // The world runs on the CPU; a later, smaller world may still
                // use the device unless it has failed outright.
                if (e.device_lost()) {
                    fail_vulkan(e.what());
                } else {
                    try { vulkan_->release(); } catch (...) {}
                    vulkan_health_ = BackendHealth::Available;
                    log("WARN", std::string("compute.backend.fallback vulkan could not take this world: ") + e.what());
                }
                selection_reason_ = std::string("Vulkan could not take this world: ") + e.what();
                inputs_.request_full_upload();
            }
        }
    }
    log("INFO", std::string("compute.backend.selected ") + to_string(active_) + " (" + size + "): " + selection_reason_);
}

void ComputeDispatcher::calibrate() {
    // Time both backends on this world, from its initial state, with a
    // midday step and every module on. The step is a pure function of state
    // and inputs, so neither run has a side effect on the simulation; the
    // device's state is reset afterwards.
    constexpr int kWarm = 2, kTimed = 5;
    StepParams params;
    params.begin(tables_, 43'200, 1, MOD_TRAFFIC | MOD_SIGNALS | MOD_BUILDINGS | MOD_FLOODING, to_q30(0.75));
    const std::vector<std::pair<std::uint32_t, std::uint32_t>> none;
    StepResult result;

    std::vector<double> cpu_times;
    auto scratch = state_;
    for (int i = 0; i < kWarm + kTimed; ++i) {
        const auto started = Clock::now();
        cpu_->step({params, inputs_, none}, scratch, result);
        if (i >= kWarm) cpu_times.push_back(ms_since(started));
    }

    std::vector<double> gpu_times;
    scratch = state_;
    try {
        for (int i = 0; i < kWarm + kTimed; ++i) {
            const auto started = Clock::now();
            vulkan_->step({params, inputs_, none}, scratch, result);
            if (i == 0) inputs_.mark_uploaded();
            if (i >= kWarm) gpu_times.push_back(ms_since(started));
        }
        vulkan_->upload_state(state_);
    } catch (const ComputeError& e) {
        fail_vulkan(std::string("calibration failed: ") + e.what());
        inputs_.request_full_upload();
        return;
    }
    calibration_.ran = true;
    calibration_.cpu_ms = median(cpu_times);
    calibration_.vulkan_ms = median(gpu_times);
    // A margin, so that a near tie stays on the reference backend.
    calibration_.chosen = calibration_.vulkan_ms < calibration_.cpu_ms * 0.9 ? "vulkan" : "cpu";
    std::ostringstream out;
    out.precision(3);
    out << "compute.calibration cpu=" << calibration_.cpu_ms << " ms vulkan=" << calibration_.vulkan_ms
        << " ms per step; chose " << calibration_.chosen;
    log("INFO", out.str());
}

void ComputeDispatcher::fail_vulkan(const std::string& reason) {
    vulkan_health_ = BackendHealth::Failed;
    vulkan_reason_ = reason;
    last_failure_ = reason;
    log("ERROR", "compute.backend.fallback vulkan failed, continuing on the CPU: " + reason);
    if (vulkan_) {
        try {
            vulkan_->release();
        } catch (...) {
        }
        // A failed device is torn down, not retried: the next world uses the CPU.
        vulkan_.reset();
    }
    active_ = BackendType::Cpu;
    inputs_.request_full_upload();
}

bool ComputeDispatcher::select(BackendType type, const std::string& reason) {
    if (!installed_ || type == active_) return type == active_;
    if (type == BackendType::Cpu) {
        ensure_host_state();
        patches_.clear();
        if (vulkan_) vulkan_->release();
        if (vulkan_health_ == BackendHealth::Active) vulkan_health_ = BackendHealth::Available;
        active_ = BackendType::Cpu;
        inputs_.request_full_upload();
        selection_reason_ = reason;
        log("INFO", "compute.backend.selected cpu: " + reason);
        return true;
    }
    if (vulkan_health_ == BackendHealth::Disabled) return false;
    initialize();
    if (!vulkan_ || vulkan_health_ == BackendHealth::Failed) return false;
    try {
        vulkan_->install(tables_);
        vulkan_->upload_state(state_);
        inputs_.request_full_upload();
    } catch (const ComputeError& e) {
        try { vulkan_->release(); } catch (...) {}
        log("WARN", std::string("compute.backend.select vulkan refused: ") + e.what());
        return false;
    }
    patches_.clear();
    active_ = BackendType::Vulkan;
    vulkan_health_ = BackendHealth::Active;
    take_shadow();
    selection_reason_ = reason;
    log("INFO", "compute.backend.selected vulkan: " + reason);
    return true;
}

// --- Inputs ------------------------------------------------------------------

void ComputeDispatcher::set_signal_phase(std::uint32_t signal, std::uint32_t phase) {
    if (signal < tables_.signal_count) inputs_.set(tables_.phase_base() + signal, phase);
}

void ComputeDispatcher::set_signal_override(std::uint32_t node, int phase) {
    if (node >= tables_.node_count || overrides_[node] == phase) return;
    overrides_[node] = phase;
    inputs_.set(tables_.override_base() + node, static_cast<std::uint32_t>(std::clamp(phase, 0, 2)));
}

void ComputeDispatcher::sync_signal_overrides(const std::map<std::uint32_t, int>& overrides) {
    for (const auto node : override_nodes_)
        if (!overrides.contains(node)) set_signal_override(node, 0);
    override_nodes_.clear();
    for (const auto& [node, phase] : overrides) {
        set_signal_override(node, phase);
        if (phase != 0 && node < tables_.node_count) override_nodes_.push_back(node);
    }
}

void ComputeDispatcher::set_attraction(std::uint32_t edge, double value) {
    if (edge < tables_.edge_count) inputs_.set(tables_.edge_input(IN_ATTRACTION, edge), static_cast<std::uint32_t>(to_q28(value)));
}

void ComputeDispatcher::set_manual(std::uint32_t edge, const ManualControl& c) {
    if (edge >= tables_.edge_count) throw std::out_of_range("unknown edge");
    inputs_.set(tables_.edge_input(IN_MANUAL_SPEED, edge), to_q30(std::clamp(c.speed_multiplier, 0.0, 2.0)));
    inputs_.set(tables_.edge_input(IN_MANUAL_CAPACITY, edge), to_q30(std::clamp(c.capacity_multiplier, 0.0, 2.0)));
    inputs_.set(tables_.edge_input(IN_MANUAL_CLOSED, edge), c.closed ? 1u : 0u);
    // The closure applies at once, before the next step, as it always has.
    const auto flags_at = tables_.edge_state(EV_FLAGS, edge);
    const auto flood = state_[tables_.edge_state(EV_FLOOD, edge)];
    const bool closed = c.closed || flood >= FLOOD_CONTROL_CLOSED_Q30;
    const auto flags = closed ? (state_[flags_at] | STATE_CLOSED) : (state_[flags_at] & ~STATE_CLOSED);
    patch_state(flags_at, flags);
}

ManualControl ComputeDispatcher::manual(std::uint32_t edge) const {
    if (edge >= tables_.edge_count) throw std::out_of_range("unknown edge");
    return {from_q30(inputs_.get(tables_.edge_input(IN_MANUAL_SPEED, edge))),
            from_q30(inputs_.get(tables_.edge_input(IN_MANUAL_CAPACITY, edge))),
            inputs_.get(tables_.edge_input(IN_MANUAL_CLOSED, edge)) != 0};
}

void ComputeDispatcher::update_incidents(const Scenario& scenario, std::uint32_t t, bool enabled) {
    for (const auto& [edge, list] : tables_.incident_edges) {
        double speed = 1.0, capacity = 1.0;
        bool closed = false;
        if (enabled) {
            for (const auto k : list) {
                const auto& inc = scenario.incidents[k];
                if (t < inc.start_virtual_s || t >= inc.end_virtual_s) continue;
                speed = std::min(speed, inc.speed_multiplier);
                capacity = std::min(capacity, inc.capacity_multiplier);
                closed = closed || inc.closed;
            }
        }
        inputs_.set(tables_.edge_input(IN_INCIDENT_SPEED, edge), to_q30(std::clamp(speed, 0.0, 1.0)));
        inputs_.set(tables_.edge_input(IN_INCIDENT_CAPACITY, edge), to_q30(std::clamp(capacity, 0.0, 1.0)));
        inputs_.set(tables_.edge_input(IN_INCIDENT_CLOSED, edge), closed ? 1u : 0u);
    }
}

void ComputeDispatcher::patch_state(std::size_t offset, std::uint32_t value) {
    state_[offset] = value;
    if (active_ != BackendType::Vulkan) return;
    const auto at = static_cast<std::uint32_t>(offset);
    for (auto& p : patches_)
        if (p.first == at) {
            p.second = value;
            return;
        }
    patches_.emplace_back(at, value);
}

// --- The step ------------------------------------------------------------------

StepOutcome ComputeDispatcher::step(const StepRequest& r) {
    if (!installed_) throw std::logic_error("no world installed in the compute dispatcher");
    params_.begin(tables_, r.virtual_s, r.dt, modules_of(r), to_q30(std::clamp(r.day_profile, 0.0, 1.0)));
    for (const auto& s : r.storms)
        params_.add_storm(to_pos(s.x_m), to_pos(s.y_m), to_pos_radius(s.radius_m), to_q30(std::clamp(s.intensity, 0.0, 1.0)));
    for (const auto& s : r.surges) {
        if (s.node >= tables_.node_count) continue;
        params_.add_surge(static_cast<std::int32_t>(tables_.node(NS_X, s.node)), static_cast<std::int32_t>(tables_.node(NS_Y, s.node)),
                          to_pos_radius(s.radius_m), to_q16(std::clamp(s.factor, 0.0, 65535.0)));
    }

    StepResult result;
    const auto started = Clock::now();
    if (active_ == BackendType::Vulkan) {
        std::vector<std::uint32_t> before;
        if (options_.verify) {
            ensure_host_state();
            before = state_;
        }
        try {
            vulkan_->step({params_, inputs_, patches_}, state_, result);
            JournalEntry entry;
            entry.params = params_.words;
            entry.inputs.reserve(inputs_.dirty().size());
            for (const auto offset : inputs_.dirty()) entry.inputs.emplace_back(offset, inputs_.get(offset));
            entry.patches = patches_;
            journal_.push_back(std::move(entry));
            inputs_.mark_uploaded();
            patches_.clear();
            host_complete_ = false;
            record(BackendType::Vulkan, vulkan_->last_step(), ms_since(started));
            if (options_.verify) verify_step(before, result);
            // Bound the journal: refresh the shadow with a full download now and then.
            else if (journal_.size() >= kShadowInterval) ensure_host_state();
        } catch (const ComputeError& e) {
            ++fallbacks_;
            const bool intact = e.state_intact();
            if (!host_complete_ && intact && vulkan_) {
                // Recover the committed state, S[t], from the device.
                try {
                    vulkan_->download_state(state_);
                    for (const auto& [offset, value] : patches_) state_[offset] = value;
                    host_complete_ = true;
                } catch (const ComputeError&) {
                }
            }
            const auto pending = patches_;
            fail_vulkan(e.what());
            if (!host_complete_ && rebuild_from_shadow()) {
                // The patches made before this step still apply to the rebuilt state.
                for (const auto& [offset, value] : pending) state_[offset] = value;
            }
            patches_.clear();
            if (!host_complete_) {
                needs_recovery_ = true;
                throw StateLost(std::string("accelerator state lost: ") + e.what());
            }
            // Recompute this step on the CPU from the intact committed state.
            run_cpu(result);
            record(BackendType::Cpu, cpu_->last_step(), ms_since(started));
        }
    } else {
        run_cpu(result);
        record(BackendType::Cpu, cpu_->last_step(), ms_since(started));
    }

    StepOutcome outcome;
    outcome.transitions = result.transitions;
    if (tables_.weight_total > 0)
        outcome.congestion_index = std::clamp(100.0 * double(result.congestion_sum) / (double(tables_.weight_total) * 65536.0), 0.0, 100.0);
    return outcome;
}

void ComputeDispatcher::run_cpu(StepResult& result) {
    cpu_->step({params_, inputs_, patches_}, state_, result);
    // The CPU reads the mirror directly. A device copy, if one is ever needed
    // again, is replaced wholesale when that backend is selected.
    inputs_.mark_uploaded();
    patches_.clear();
    host_complete_ = true;
}

void ComputeDispatcher::verify_step(const std::vector<std::uint32_t>& before, const StepResult& gpu) {
    // Recompute the step on the CPU from the same starting state and compare
    // every word. Debug only: it costs a full download and a CPU step.
    auto expected = before;
    StepResult cpu;
    cpu_->step({params_, inputs_, {}}, expected, cpu);
    vulkan_->download_state(state_);
    host_complete_ = true;
    ++verified_;
    std::size_t mismatches = 0;
    std::ostringstream detail;
    for (std::size_t i = 0; i < expected.size(); ++i) {
        if (expected[i] == state_[i]) continue;
        if (mismatches++ < 8) {
            const bool node = i < tables_.edge_state_base();
            const auto local = node ? i : i - tables_.edge_state_base();
            const auto stride = node ? tables_.node_stride : tables_.edge_stride;
            detail << (node ? " node " : " edge ") << local % stride << " field " << local / stride
                   << " cpu=" << expected[i] << " vulkan=" << state_[i] << ';';
        }
    }
    if (cpu.transitions != gpu.transitions || cpu.congestion_sum != gpu.congestion_sum) {
        ++mismatches;
        detail << " reductions cpu=" << cpu.transitions << '/' << cpu.congestion_sum << " vulkan=" << gpu.transitions << '/' << gpu.congestion_sum << ';';
    }
    if (!mismatches) {
        take_shadow();
        return;
    }
    const auto message = "compute.verify mismatch at virtual second " + std::to_string(params_.words[P_VIRTUAL_S]) + ": " +
                         std::to_string(mismatches) + " word(s) differ." + detail.str();
    log("ERROR", message);
    // The CPU's answer is the reference: continue from it.
    state_ = std::move(expected);
    fail_vulkan(message);
}

void ComputeDispatcher::record(BackendType ran, const StepTelemetry& t, double total_ms) {
    last_ = t;
    last_backend_ = ran;
    last_total_ms_ = total_ms;
    upload_bytes_ += t.upload_bytes;
    readback_bytes_ += t.readback_bytes;
    if (ran == BackendType::Vulkan) {
        ++steps_vulkan_;
        total_ms_vulkan_ += total_ms;
    } else {
        ++steps_cpu_;
        total_ms_cpu_ += total_ms;
    }
}

// --- State ----------------------------------------------------------------------

void ComputeDispatcher::ensure_host_state() {
    if (host_complete_) return;
    std::string failure = "the accelerator is gone";
    if (vulkan_) {
        try {
            vulkan_->download_state(state_);
            for (const auto& [offset, value] : patches_) state_[offset] = value;
            host_complete_ = true;
            ++downloads_;
            readback_bytes_ += state_.size() * sizeof(std::uint32_t);
            take_shadow();
            return;
        } catch (const ComputeError& e) {
            failure = e.what();
        }
    }
    const auto pending = patches_;
    fail_vulkan(failure);
    if (rebuild_from_shadow()) {
        for (const auto& [offset, value] : pending) state_[offset] = value;
        return;
    }
    needs_recovery_ = true;
    throw StateLost("accelerator state lost while reading it back: " + failure);
}

void ComputeDispatcher::take_shadow() {
    journal_.clear();
    if (active_ != BackendType::Vulkan || !host_complete_) {
        shadow_state_.clear();
        shadow_inputs_.clear();
        return;
    }
    shadow_state_ = state_;
    shadow_inputs_ = inputs_.words();
}

bool ComputeDispatcher::rebuild_from_shadow() {
    if (shadow_state_.size() != tables_.state_words()) return false;
    // Replay every journalled step on the CPU, from the shadow, with exactly
    // the inputs and patches the device was given.
    auto state = shadow_state_;
    auto inputs = shadow_inputs_;
    StepParams params;
    for (const auto& entry : journal_) {
        for (const auto& [offset, value] : entry.inputs) inputs[offset] = value;
        for (const auto& [offset, value] : entry.patches) state[offset] = value;
        params.words = entry.params;
        StepResult ignored;
        cpu_node_pass(tables_, params, state);
        cpu_edge_pass(tables_, params, inputs, state, 0, tables_.edge_count, ignored);
    }
    log("WARN", "compute.recovery rebuilt the state on the CPU by replaying " + std::to_string(journal_.size()) + " journalled step(s)");
    state_ = std::move(state);
    host_complete_ = true;
    ++replays_;
    journal_.clear();
    shadow_state_.clear();
    shadow_inputs_.clear();
    return true;
}

std::vector<std::uint32_t> ComputeDispatcher::export_state() {
    ensure_host_state();
    return state_;
}

void ComputeDispatcher::import_state(const std::vector<std::uint32_t>& state) {
    if (state.size() != tables_.state_words()) throw std::invalid_argument("state does not match the installed world");
    state_ = state;
    host_complete_ = true;
    patches_.clear();
    if (active_ == BackendType::Vulkan) {
        try {
            vulkan_->upload_state(state_);
        } catch (const ComputeError& e) {
            fail_vulkan(e.what());
        }
    }
    take_shadow();
}

void ComputeDispatcher::reset_state() { import_state(initial_state(tables_)); }

EdgeConditions ComputeDispatcher::conditions() const {
    if (!installed_ || tables_.edge_count == 0) return {};
    return {&state_[tables_.edge_state(EV_RAIN, 0)], &state_[tables_.edge_state(EV_FLOOD, 0)],
            &state_[tables_.edge_state(EV_FLAGS, 0)], tables_.edge_count};
}

double ComputeDispatcher::edge_flood(std::uint32_t edge) const { return from_q30(state_[tables_.edge_state(EV_FLOOD, edge)]); }

bool ComputeDispatcher::flood_transition(std::uint32_t edge) const {
    return (state_[tables_.edge_state(EV_FLAGS, edge)] & STATE_FLOOD_TRANSITION) != 0;
}

void ComputeDispatcher::materialize(std::vector<NodeDynamic>& nodes, std::vector<EdgeDynamic>& edges, std::uint64_t revision) const {
    // The double-precision view is a cache of the authoritative state; filling
    // it may download that state, which is why this const method may change
    // the host copy.
    const_cast<ComputeDispatcher*>(this)->ensure_host_state();
    ++view_downloads_;
    const auto& t = tables_;
    const auto& s = state_;
    nodes.resize(t.node_count);
    for (std::uint32_t n = 0; n < t.node_count; ++n) {
        auto& d = nodes[n];
        d.rainfall = from_q30(s[t.node_state(NV_RAIN, n)]);
        d.flood = from_q30(s[t.node_state(NV_FLOOD, n)]);
        d.building_effect = 0;
        d.state_revision = revision;
    }
    edges.resize(t.edge_count);
    for (std::uint32_t e = 0; e < t.edge_count; ++e) {
        auto& d = edges[e];
        auto at = [&](std::uint32_t field) { return s[t.edge_state(field, e)]; };
        const auto rain = u64(at(EV_RAIN)), flood = u64(at(EV_FLOOD));
        const auto flags = at(EV_FLAGS);
        const bool allowed = (t.edge(ES_FLAGS, e) & EDGE_ALLOWED) != 0;
        d.demand_vph = from_q8(static_cast<std::int32_t>(at(EV_DEMAND)));
        d.effective_capacity_vph = from_q8(at(EV_CAPACITY));
        d.effective_speed_mps = from_q16(at(EV_SPEED));
        d.rainfall = from_q30(rain);
        d.flood = from_q30(flood);
        d.congestion_model = from_q30(at(EV_CONGESTION_MODEL));
        d.congestion_observed = from_q30(at(EV_CONGESTION_OBSERVED));
        d.congestion = from_q30(at(EV_CONGESTION));
        d.signal_multiplier = from_q30(at(EV_SIGNAL));
        // Only traversable directions have environmental multipliers evaluated.
        d.rain_speed_multiplier = allowed ? from_q30(rain_speed_factor(rain)) : 1.0;
        d.flood_speed_multiplier = allowed ? from_q30(flood_speed_factor(flood)) : 1.0;
        d.rain_capacity_multiplier = allowed ? from_q30(rain_capacity_factor(rain)) : 1.0;
        d.flood_capacity_multiplier = allowed ? from_q30(flood_capacity_factor(flood)) : 1.0;
        d.manual_speed_multiplier = from_q30(inputs_.get(t.edge_input(IN_MANUAL_SPEED, e)));
        d.manual_capacity_multiplier = from_q30(inputs_.get(t.edge_input(IN_MANUAL_CAPACITY, e)));
        d.manual_closed = inputs_.get(t.edge_input(IN_MANUAL_CLOSED, e)) != 0;
        d.incident_speed_multiplier = from_q30(at(EV_INCIDENT_SPEED));
        d.incident_capacity_multiplier = from_q30(at(EV_INCIDENT_CAPACITY));
        d.vehicle_count = at(EV_COUNT);
        d.halting_count = at(EV_HALTING);
        d.vehicle_load = from_q16(at(EV_LOAD));
        d.mean_speed_mps = from_q16(at(EV_MEAN_SPEED));
        d.occupancy = from_q30(at(EV_OCCUPANCY));
        d.incident_closed = (flags & STATE_INCIDENT_CLOSED) != 0;
        d.closed = (flags & STATE_CLOSED) != 0;
        d.state_revision = revision;
    }
}

// --- Reporting ---------------------------------------------------------------------

nlohmann::json ComputeDispatcher::describe() const {
    nlohmann::json options = nlohmann::json::object();
    for (const auto& [k, v] : options_.describe()) options[k] = v;
    nlohmann::json device = nullptr;
    if (vulkan_) device = capabilities_json(vulkan_->capabilities());
    const auto cpu_caps = cpu_->capabilities();
    nlohmann::json passes = nlohmann::json::object();
    for (const auto& [name, ms] : last_.passes) passes[name] = ms;
    nlohmann::json calibration = nullptr;
    if (calibration_.ran)
        calibration = {{"cpu_ms", calibration_.cpu_ms}, {"vulkan_ms", calibration_.vulkan_ms}, {"chosen", calibration_.chosen}};
    const auto device_bytes = active_ == BackendType::Vulkan ? tables_.footprint_bytes() + tables_.state_words() * 4 : 0;
    return {
        {"requested_backend", to_string(options_.backend)},
        {"active_backend", to_string(active_)},
        {"fallback_backend", "cpu"},
        {"selection_reason", selection_reason_},
        {"health", {{"cpu", active_ == BackendType::Cpu ? "active" : "available"}, {"vulkan", to_string(vulkan_health_)}}},
        {"vulkan_compiled", vulkan_compiled()},
        {"vulkan_available", vulkan_ != nullptr},
        {"fallback_reason", vulkan_reason_.empty() ? nlohmann::json(nullptr) : nlohmann::json(vulkan_reason_)},
        {"last_failure", last_failure_.empty() ? nlohmann::json(nullptr) : nlohmann::json(last_failure_)},
        {"deterministic", true},
        {"device", device},
        {"cpu", {{"threads", cpu_caps.threads}, {"parallel_above_edges", CpuComputeBackend::kParallelEdges}}},
        {"workload", {{"installed", installed_}, {"nodes", tables_.node_count}, {"edges", tables_.edge_count}, {"signals", tables_.signal_count}}},
        {"thresholds", {{"min_nodes", options_.min_nodes}, {"min_edges", options_.min_edges}, {"calibrate", options_.calibrate}}},
        {"calibration", calibration},
        {"step", {
            {"backend", to_string(last_backend_)},
            {"total_ms", last_total_ms_},
            {"cpu_ms", last_.host_ms},
            {"gpu_ms", last_.device_ms},
            {"upload_bytes", last_.upload_bytes},
            {"readback_bytes", last_.readback_bytes},
            {"dispatches", last_.dispatches},
            {"passes", passes}
        }},
        {"totals", {
            {"steps_cpu", steps_cpu_}, {"steps_vulkan", steps_vulkan_},
            {"mean_step_ms_cpu", steps_cpu_ ? total_ms_cpu_ / double(steps_cpu_) : 0.0},
            {"mean_step_ms_vulkan", steps_vulkan_ ? total_ms_vulkan_ / double(steps_vulkan_) : 0.0},
            {"fallbacks", fallbacks_}, {"verified_steps", verified_}, {"state_downloads", downloads_},
            {"journal_replays", replays_}, {"journal_steps", journal_.size()},
            {"upload_bytes", upload_bytes_}, {"readback_bytes", readback_bytes_}
        }},
        {"memory", {{"host_state_bytes", state_.size() * 4}, {"device_bytes_estimate", device_bytes}}},
        {"options", options}
    };
}

} // namespace dstns::compute
