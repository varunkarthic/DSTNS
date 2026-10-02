// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// CPU and Vulkan backends must produce the same state, bit for bit.
//
// Each case drives a CPU dispatcher and a Vulkan dispatcher through the same
// randomised sequence of inputs (storms, surges, signal phases and overrides,
// demand couplings, incidents, operator closures, module switches) and
// compares every step's reductions and host-facing fields, and the complete
// state at intervals. It runs on every usable Vulkan device, software ones
// included, at problem sizes on either side of each workgroup boundary, and
// through every failure path the dispatcher handles.
//
// Exit 77 (skipped) when no Vulkan device is available.

#include "dstns/compute/dispatcher.hpp"
#include "dstns/compute/synthetic.hpp"
#include "dstns/compute/vulkan.hpp"
#include "dstns/scenario.hpp"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using namespace dstns;
using namespace dstns::compute;

int failures = 0;
int checks = 0;
std::atomic<int> validation_errors{0};

void check(bool condition, const std::string& what) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << what << "\n";
    }
}

LogSink sink() {
    return [](const std::string& level, const std::string& message) {
        if (message.rfind("compute.vulkan.validation", 0) == 0 && level == "ERROR") {
            ++validation_errors;
            std::cerr << message << "\n";
        }
    };
}

std::uint64_t mix(std::uint64_t x) {
    x ^= x >> 33; x *= 0xff51afd7ed558ccdull; x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ull; x ^= x >> 33;
    return x;
}
double unit(std::uint64_t a, std::uint64_t b) { return double(mix(a * 0x9E3779B97F4A7C15ull + b) >> 11) / double(1ull << 53); }

ComputeOptions cpu_options() {
    ComputeOptions o;
    o.backend = BackendPreference::Cpu;
    o.cpu_threads = 1;
    return o;
}

ComputeOptions gpu_options(const std::string& device, std::uint32_t workgroup = 0) {
    ComputeOptions o;
    o.backend = BackendPreference::Vulkan;
    o.device = device;
    o.allow_software_vulkan = true;
    o.calibrate = false;
    o.workgroup_size = workgroup;
    o.cache_dir.clear();
    const char* validation = std::getenv("DSTNS_VULKAN_VALIDATION");
    o.validation = validation && std::string(validation) == "1";
    return o;
}

/// Apply the pseudo-random inputs for step `t` to a dispatcher. Like the
/// engine, every step sets every input it uses, so the inputs at step t do not
/// depend on how the run reached it; operator closures, which stand until
/// undone, are made only before `controls_until`.
StepRequest drive(ComputeDispatcher& d, const Scenario& s, std::uint32_t t, std::uint64_t seed, std::uint32_t controls_until = 1u << 30) {
    const auto& tables = d.tables();
    for (std::uint32_t i = 0; i < tables.signal_count; ++i) d.set_signal_phase(i, std::uint32_t(mix(seed + t * 131 + i) % 6));
    if (tables.node_count) {
        std::map<std::uint32_t, int> overrides;
        const auto epoch = t / 11;
        if (epoch % 3 != 0)
            for (int k = 0; k < 3; ++k) overrides[std::uint32_t(mix(seed + epoch + k) % tables.node_count)] = int(1 + mix(seed ^ epoch ^ k) % 2);
        d.sync_signal_overrides(overrides);
    }
    if (tables.edge_count) {
        for (std::uint32_t e = 0; e < tables.edge_count; e += 5)
            d.set_attraction(e, -1.0 + 3.0 * unit(seed + t, e));
        if (t % 13 == 5 && t < controls_until) {
            const auto edge = std::uint32_t(mix(seed + t * 3) % tables.edge_count);
            d.set_manual(edge, {2.0 * unit(seed, t), 2.0 * unit(seed + 1, t), unit(seed + 2, t) < .3});
        }
    }
    const auto virtual_s = (t * 437) % 86'400;
    d.update_incidents(s, virtual_s, t % 17 != 0);
    StepRequest r;
    r.virtual_s = virtual_s;
    r.dt = 1;
    r.day_profile = unit(seed, t + 9000);
    r.traffic = t % 23 != 0;
    r.signals = t % 19 != 0;
    r.buildings = t % 29 != 0;
    r.flooding = t % 31 != 0;
    double extent = 0;
    for (const auto& n : s.nodes) extent = std::max({extent, n.position.x_m, n.position.y_m});
    const auto storms = mix(seed + t) % 4;
    for (std::uint64_t k = 0; k < storms; ++k)
        r.storms.push_back({extent * unit(seed + k, t), extent * unit(seed + k + 10, t), 50 + 3000 * unit(seed + k + 20, t), unit(seed + k + 30, t)});
    if (tables.node_count) {
        const auto surges = mix(seed + t + 77) % 3;
        for (std::uint64_t k = 0; k < surges; ++k)
            r.surges.push_back({std::uint32_t(mix(seed + k + t) % tables.node_count), 1 + 4 * unit(seed + k, t + 1), 50 + 1500 * unit(seed + k, t + 2)});
    }
    return r;
}

bool same_conditions(const ComputeDispatcher& a, const ComputeDispatcher& b) {
    const auto x = a.conditions(), y = b.conditions();
    if (x.count != y.count) return false;
    for (std::size_t e = 0; e < x.count; ++e)
        if (x.rain_q30[e] != y.rain_q30[e] || x.flood_q30[e] != y.flood_q30[e] || x.flags[e] != y.flags[e]) return false;
    return true;
}

std::string first_difference(const std::vector<std::uint32_t>& a, const std::vector<std::uint32_t>& b, const StaticTables& t) {
    for (std::size_t i = 0; i < a.size() && i < b.size(); ++i) {
        if (a[i] == b[i]) continue;
        std::ostringstream out;
        if (i < t.edge_state_base()) out << "node " << i % t.node_stride << " field " << i / t.node_stride;
        else out << "edge " << (i - t.edge_state_base()) % t.edge_stride << " field " << (i - t.edge_state_base()) / t.edge_stride;
        out << ": cpu " << a[i] << " vulkan " << b[i];
        return out.str();
    }
    return a.size() == b.size() ? "none" : "sizes differ";
}

/// Run `steps` steps through both backends and compare.
void equivalence(const std::string& label, const Scenario& s, const ComputeOptions& gpu, std::uint32_t steps, std::uint32_t full_every) {
    ComputeDispatcher cpu(cpu_options(), sink());
    ComputeDispatcher vk(gpu, sink());
    cpu.install(s);
    vk.install(s);
    if (vk.active() != BackendType::Vulkan) {
        check(false, label + ": Vulkan did not take the world: " + vk.describe()["selection_reason"].get<std::string>());
        return;
    }
    const std::uint64_t seed = 0xD57E5 + s.nodes.size();
    for (std::uint32_t t = 1; t <= steps; ++t) {
        const auto a = cpu.step(drive(cpu, s, t, seed));
        const auto b = vk.step(drive(vk, s, t, seed));
        if (a.transitions != b.transitions || a.congestion_index != b.congestion_index || !same_conditions(cpu, vk)) {
            check(false, label + ": step " + std::to_string(t) + " differs (reductions or host fields)");
            return;
        }
        if (t % full_every == 0 || t == steps) {
            const auto x = cpu.export_state(), y = vk.export_state();
            if (x != y) {
                check(false, label + ": full state differs at step " + std::to_string(t) + ", first at " + first_difference(x, y, cpu.tables()));
                return;
            }
        }
    }
    check(vk.active() == BackendType::Vulkan, label + ": stayed on Vulkan");
    check(true, label);
    std::cout << "  ok  " << label << " (" << s.nodes.size() << " nodes, " << s.edges.size() << " edges, " << steps << " steps)\n";
}

/// Restore an exported state into both backends and continue: checkpoints.
void checkpoint_replay(const std::string& device) {
    const auto s = synthetic_world(900, 3);
    ComputeDispatcher reference(cpu_options(), sink());
    ComputeDispatcher vk(gpu_options(device), sink());
    reference.install(s);
    vk.install(s);
    const std::uint64_t seed = 99;
    std::vector<std::uint32_t> checkpoint;
    constexpr std::uint32_t controls_after_checkpoint = 30;
    for (std::uint32_t t = 1; t <= 60; ++t) {
        (void)reference.step(drive(reference, s, t, seed, controls_after_checkpoint));
        (void)vk.step(drive(vk, s, t, seed, controls_after_checkpoint));
        if (t == 30) checkpoint = vk.export_state();
    }
    (void)controls_after_checkpoint;
    const auto continuous = reference.export_state();
    // Back to step 30 on the device, then replay 31..60 with the same inputs.
    vk.import_state(checkpoint);
    for (std::uint32_t t = 31; t <= 60; ++t) (void)vk.step(drive(vk, s, t, seed, controls_after_checkpoint));
    check(vk.export_state() == continuous, "checkpoint restore + replay on " + device + " equals continuous execution");
    std::cout << "  ok  checkpoint restore and replay\n";
}

/// Move a run between backends at step boundaries; nothing may change.
void hot_switch(const std::string& device) {
    const auto s = synthetic_world(2000, 4);
    ComputeDispatcher reference(cpu_options(), sink());
    auto options = gpu_options(device);
    options.backend = BackendPreference::Auto;
    options.min_nodes = options.min_edges = 100'000'000; // start on the CPU
    ComputeDispatcher mover(options, sink());
    reference.install(s);
    mover.install(s);
    check(mover.active() == BackendType::Cpu, "auto mode keeps a small world on the CPU");
    const std::uint64_t seed = 5;
    for (std::uint32_t t = 1; t <= 90; ++t) {
        if (t == 20) check(mover.select(BackendType::Vulkan, "test"), "switch CPU -> Vulkan");
        if (t == 55) check(mover.select(BackendType::Cpu, "test"), "switch Vulkan -> CPU");
        if (t == 70) check(mover.select(BackendType::Vulkan, "test"), "switch CPU -> Vulkan again");
        (void)reference.step(drive(reference, s, t, seed));
        (void)mover.step(drive(mover, s, t, seed));
    }
    check(mover.export_state() == reference.export_state(), "hot switching between backends leaves the state unchanged");
    std::cout << "  ok  hot switching CPU <-> Vulkan\n";
}

/// A failure at step 7, and what the dispatcher makes of it.
void fault(const std::string& device, FaultInjection::Kind kind, const std::string& name) {
    const auto s = synthetic_world(700, 6);
    ComputeDispatcher reference(cpu_options(), sink());
    auto options = gpu_options(device);
    options.fault = {kind, 7};
    if (kind == FaultInjection::Kind::Mismatch) options.verify = true;
    ComputeDispatcher subject(options, sink());
    reference.install(s);
    subject.install(s);
    const std::uint64_t seed = 21;
    if (kind == FaultInjection::Kind::Allocation || kind == FaultInjection::Kind::Pipeline || kind == FaultInjection::Kind::Initialisation) {
        check(subject.active() == BackendType::Cpu, name + ": the world runs on the CPU");
        for (std::uint32_t t = 1; t <= 20; ++t) {
            (void)reference.step(drive(reference, s, t, seed));
            (void)subject.step(drive(subject, s, t, seed));
        }
        check(subject.export_state() == reference.export_state(), name + ": results unchanged");
        std::cout << "  ok  " << name << " -> CPU (" << subject.describe()["selection_reason"].get<std::string>() << ")\n";
        return;
    }
    for (std::uint32_t t = 1; t <= 20; ++t) {
        (void)reference.step(drive(reference, s, t, seed));
        try {
            (void)subject.step(drive(subject, s, t, seed));
        } catch (const StateLost& lost) {
            check(false, name + ": the dispatcher should have recovered by itself: " + lost.what());
            return;
        }
        // Operator actions between checkpoints must survive a recovery too.
        if (t == 6 && subject.tables().edge_count) {
            reference.set_manual(1, {0.5, 0.25, true});
            subject.set_manual(1, {0.5, 0.25, true});
        }
    }
    check(subject.active() == BackendType::Cpu, name + ": continues on the CPU");
    check(subject.describe()["health"]["vulkan"] == "failed", name + ": Vulkan marked failed, not retried");
    check(subject.export_state() == reference.export_state(), name + ": the run is identical to a CPU-only run");
    std::cout << "  ok  " << name << " -> CPU without changing the run\n";
}

} // namespace

int main() {
    std::cout << "[compute-equivalence] CPU and Vulkan backends, bit for bit\n";
    ComputeOptions probe;
    probe.allow_software_vulkan = true;
    probe.cache_dir.clear();
    const auto report = vulkan_diagnostics(probe);
    std::vector<std::string> devices;
    for (const auto& d : report["devices"])
        if (d.value("usable", false) && d.contains("self_test") && d["self_test"].value("passed", false))
            devices.push_back(std::to_string(d["index"].get<int>()) + ":" + d["name"].get<std::string>() + " (" + d["driver"].get<std::string>() + ")");
    if (devices.empty()) {
        std::cout << "SKIPPED: no usable Vulkan device (" << report.value("reason", std::string("Vulkan unavailable")) << ")\n";
        return 77;
    }

    const std::vector<std::uint32_t> boundary{1, 2, 63, 64, 65, 127, 128, 129, 255, 256, 257, 511, 513};
    for (const auto& entry : devices) {
        const auto index = entry.substr(0, entry.find(':'));
        std::cout << "device " << entry << "\n";
        for (const auto n : boundary) equivalence("boundary " + std::to_string(n), synthetic_world(n, n), gpu_options(index), 40, 10);
        for (const std::uint32_t wg : {64u, 128u, 256u})
            equivalence("workgroup " + std::to_string(wg), synthetic_world(3000, 11), gpu_options(index, wg), 60, 20);
        equivalence("large world", synthetic_world(60'000, 12), gpu_options(index), 30, 15);

        ScenarioConfig config;
        config.grid_width = 14;
        config.grid_height = 12;
        config.dws_frequency = 5;
        config.playback_duration_s = 600;
        const auto compiled = ScenarioCompiler{}.compile(Seed128::parse("0xC0FFEE0123456789ABCDEF0011223344"), config);
        equivalence("compiled scenario", compiled, gpu_options(index), 400, 50);
        config.osm_file = "tests/fixtures/roads.osm.xml";
        config.max_nodes = 200;
        equivalence("OSM fixture", ScenarioCompiler{}.compile(Seed128::parse("0x5d7cb"), config), gpu_options(index), 400, 50);

        checkpoint_replay(index);
        hot_switch(index);
        fault(index, FaultInjection::Kind::Submit, "submission failure");
        fault(index, FaultInjection::Kind::DeviceLost, "device loss");
        fault(index, FaultInjection::Kind::Mismatch, "verification mismatch");
        fault(index, FaultInjection::Kind::Allocation, "allocation failure");
        fault(index, FaultInjection::Kind::Pipeline, "pipeline creation failure");
        fault(index, FaultInjection::Kind::Initialisation, "initialisation failure");
    }
    check(validation_errors == 0, "no Vulkan validation errors");
    std::cout << "[compute-equivalence] " << checks << " checks, " << failures << " failures on " << devices.size() << " device(s)\n";
    return failures ? 1 : 0;
}
