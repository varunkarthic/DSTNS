// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/engine.hpp"

#include "dstns/calendar.hpp"
#include "dstns/environment/terrain.hpp"

#include "dstns/utf8.hpp"
#include "dstns/sumo_bridge.hpp"
#include "dstns/osm_fetch.hpp"

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iterator>
#include <limits>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

namespace dstns {
namespace {
// A reservation may move from the HTTP thread to the regeneration worker.
// Use an atomic lease, not a mutex unlocked by a different thread.
struct CompileLease {
    std::atomic<bool>& busy;
    explicit CompileLease(std::atomic<bool>& flag): busy(flag) {
        bool expected = false;
        if (!busy.compare_exchange_strong(expected, true))
            throw std::logic_error("world generation already in progress");
    }
    ~CompileLease() { busy.store(false); }
};

constexpr std::uint32_t day_s = 86400, ppm = 1'000'000;
std::string hhmmss(std::uint32_t s) {
    s %= day_s;
    std::ostringstream o;
    o << std::setfill('0') << std::setw(2) << s / 3600 << ':' << std::setw(2) << (s % 3600) / 60 << ':' << std::setw(2) << s % 60;
    return o.str();
}
// When and where the run is, and whether each came from the seed or from the
// configuration. The seed's own values are listed too, so a configured
// override is visible as one.
nlohmann::json calendar_json(const Scenario& s) {
    const auto derived = describe_seed(s.seed);
    return {
        {"location", {{"city", s.location_city}, {"country", s.location_country},
                      {"latitude", s.location_lat}, {"longitude", s.location_lon}, {"source", s.location_source}}},
        {"month", s.month}, {"month_name", month_name(s.month)}, {"month_source", s.month_source},
        {"day", s.config.day}, {"day_type", day_type_name(s.config.day)}, {"day_source", s.day_source},
        {"seed_derived", {{"city", derived.city}, {"country", derived.country}, {"month", derived.month},
                          {"month_name", month_name(derived.month)}, {"day_type", day_type_name(derived.day)}}},
        {"representation", "month and day type only; there is no day of the month"}
    };
}

nlohmann::json terrain_json(const env::Terrain& t) {
    const auto& p = t.provenance;
    return {
        {"source", p.source}, {"provider", p.provider}, {"dataset", p.dataset}, {"licence", p.licence},
        {"attribution", p.attribution}, {"note", p.note}, {"cache_id", p.cache_id}, {"fetched_at", p.fetched_at},
        {"zoom", p.zoom}, {"native_resolution_m", p.native_resolution_m},
        {"bounding_box", {{"south", p.south}, {"west", p.west}, {"north", p.north}, {"east", p.east}}},
        {"observed", p.observed}, {"degraded", p.degraded},
        {"data_class", p.observed ? "imported" : p.source == "synthetic" ? "synthetic" : p.degraded ? "fallback" : "assumed"},
        {"grid", {{"width", t.grid.width}, {"height", t.grid.height}, {"cell_m", t.grid.cell_m},
                  {"origin_x_m", t.grid.origin_x_m}, {"origin_y_m", t.grid.origin_y_m}}},
        {"elevation_min_m", t.min_m}, {"elevation_max_m", t.max_m}, {"hash", t.hash}
    };
}

nlohmann::json point_json(const Point& p) {
    return {{"lat", p.lat}, {"lon", p.lon}, {"x_m", p.x_m}, {"y_m", p.y_m}};
}

struct StormAtmosphericState {
    double cur_x_m;
    double cur_y_m;
    double cur_lat;
    double cur_lon;
    double cur_radius_m;
    double cur_intensity;
    double phase;
    bool active;
};

StormAtmosphericState evaluate_storm_state(const DwsEvent& e, std::uint32_t now_ppm, const NodeStatic& epic_node) {
    if (now_ppm < e.start_ppm || now_ppm >= e.end_ppm) {
        return {epic_node.position.x_m, epic_node.position.y_m, epic_node.position.lat, epic_node.position.lon, e.radius_m, 0.0, 0.0, false};
    }
    const double phase = double(now_ppm - e.start_ppm) / std::max(1u, e.end_ppm - e.start_ppm);
    
    // Dynamic Growth -> Plateau -> Dissipation
    double rad_mult = 1.0;
    double int_mult = 1.0;
    if (phase < 0.25) {
        // Smooth growth phase: radius expands smoothly from 20% to 100%
        const double t = phase / 0.25;
        rad_mult = 0.20 + 0.80 * std::sin(t * 1.5707963267948966);
        int_mult = std::sin(t * 1.5707963267948966);
    } else if (phase <= 0.70) {
        // Sustained plateau phase: full radius and peak intensity
        rad_mult = 1.0;
        int_mult = 1.0;
    } else {
        // Dissipation phase: slowly contracts and reduces smoothly to 0
        const double t = (phase - 0.70) / 0.30;
        rad_mult = 1.0 - 0.65 * t * t;
        int_mult = std::cos(t * 1.5707963267948966);
    }

    // Drifting Epicenter: slow movement across terrain with wind vector
    const double wind_angle = (e.id.value * 1.3962634) + 0.785398;
    const double drift_distance = e.radius_m * 0.30 * phase; // drifts slowly up to 30% of storm radius
    const double dx = drift_distance * std::cos(wind_angle);
    const double dy = drift_distance * std::sin(wind_angle);

    const double cur_x = epic_node.position.x_m + dx;
    const double cur_y = epic_node.position.y_m + dy;
    const double cur_lat = epic_node.position.lat + dy / 111320.0;
    const double cur_lon = epic_node.position.lon + dx / (111320.0 * std::cos(epic_node.position.lat * 0.017453292519943295));

    return {
        cur_x,
        cur_y,
        cur_lat,
        cur_lon,
        std::max(40.0, e.radius_m * rad_mult),
        std::clamp(e.intensity * int_mult, 0.0, 1.0),
        phase,
        true
    };
}
} // namespace

const char* to_string(Lifecycle x) {
    switch (x) {
        case Lifecycle::Booting: return "BOOTING";
        case Lifecycle::Idle: return "IDLE";
        case Lifecycle::Preparing: return "PREPARING";
        case Lifecycle::Ready: return "READY";
        case Lifecycle::Running: return "RUNNING";
        case Lifecycle::Paused: return "PAUSED";
        case Lifecycle::Seeking: return "SEEKING";
        case Lifecycle::Stopping: return "STOPPING";
        case Lifecycle::Stopped: return "STOPPED";
        case Lifecycle::Completed: return "COMPLETED";
        case Lifecycle::Error: return "ERROR";
        case Lifecycle::Terminating: return "TERMINATING";
    }
    return "ERROR";
}

SimulationEngine::SimulationEngine(RuntimeLogger& logger, compute::ComputeOptions compute)
    : logger_(logger),
      compute_(std::make_unique<compute::ComputeDispatcher>(
          std::move(compute), [&logger](const std::string& level, const std::string& message) {
              logger.system(level, "compute", message);
          })) {
    worker_ = std::jthread([this](std::stop_token) { loop(); });
    logger_.system("INFO", "engine", "DSTNS engine idle");
}

SimulationEngine::~SimulationEngine() {
    terminate();
    // Join before graph/state members are destroyed (worker_ is declared
    // before those members and would otherwise be destroyed after them).
    if (worker_.joinable()) worker_.join();
    if (world_worker_.joinable()) world_worker_.join();
}

void SimulationEngine::transition(Lifecycle next) {
    const auto old = lifecycle_;
    lifecycle_ = next;
    // Mirror the state where a reader can see it without the engine mutex, so
    // a health probe still answers while a map download holds that mutex for
    // minutes. Every transition goes through here, so the mirror cannot drift.
    lifecycle_mirror_.store(next, std::memory_order_relaxed);
    ++playback_revision_;
    logger_.lifecycle(run_id_, to_string(old), to_string(next), graph_ ? graph_->state_revision() : 0);
}

// Advance a running simulation to where the wall clock says it should be, so
// a rate change applies from now rather than retroactively from the anchor.
void SimulationEngine::catch_up_to_wall_clock() {
    if (lifecycle_ != Lifecycle::Running || !graph_) return;
    const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - anchor_wall_).count();
    const auto rate = day_s / double(graph_->scenario().config.playback_duration_s) * tick_rate_;
    step_to(std::min(day_s, anchor_virtual_s_ + static_cast<std::uint32_t>(elapsed * rate)));
}

void SimulationEngine::anchor_wall_clock() {
    anchor_wall_ = std::chrono::steady_clock::now();
    anchor_virtual_s_ = virtual_s_;
}

nlohmann::json SimulationEngine::prepare(Seed128 seed, const ScenarioConfig& config) {
    auto compile_lease = std::make_shared<CompileLease>(compiling_);
    std::unique_lock lock(mutex_);
    if (terminate_requested_) throw std::logic_error("simulation is terminating");
    if (lifecycle_ == Lifecycle::Running || lifecycle_ == Lifecycle::Paused) {
        stop();
    }
    transition(Lifecycle::Preparing);
    const auto generation = ++compile_generation_;
    preparation_error_.clear();
    try {
        lock.unlock();
        auto scenario = compiler_.compile(seed, config, compile_progress());
        lock.lock();
        if (generation != compile_generation_ || terminate_requested_)
            throw std::logic_error("world preparation cancelled by runtime change");
        preparing_stage_.store(0);
        run_id_ = "run_" + scenario.scenario_hash.substr(7, 12);
        adopt_world(std::move(scenario));
        tick_rate_ = config.tick_rate;
        requested_tick_rate_ = config.tick_rate;
        asb_.reset();
        virtual_s_ = 0;
        start_virtual_s_ = 0;
        manual_weather_.clear();
        active_surges_.clear();
        signal_overrides_.clear();
        news_.clear();
        commands_.clear();
        redo_.clear();
        checkpoints_.clear();
        next_command_id_ = 1;
        next_news_id_ = 1;
        next_event_id_ = 1'000'000;
        config_revision_ = 1;
        signal_by_node_.assign(graph_->scenario().nodes.size(), nullptr);
        for (const auto& sig : graph_->scenario().signals) {
            if (sig.node.value < signal_by_node_.size()) {
                signal_by_node_[sig.node.value] = &sig;
            }
        }
        events_.initialize(graph_->scenario());
        congestion_ = {};
        transition(Lifecycle::Ready);
        add_news(0, "system", "info", "SCENARIO_INITIALIZED",
                 "[" + hhmmss(virtual_s_) + "] Scenario prepared with Seed " + graph_->scenario().seed.hex(),
                 {{"scenario_hash", graph_->scenario().scenario_hash}});
        add_news(1, "system", "info", "NETWORK_TOPOLOGY_LOADED",
                 "[" + hhmmss(virtual_s_) + "] Road network loaded: " + std::to_string(graph_->edges().size()) +
                 " directional edges, " + std::to_string(graph_->nodes().size()) + " intersections.",
                 {{"edges", graph_->edges().size()}, {"nodes", graph_->nodes().size()}});
        capture_checkpoint();
        return {
            {"ok", true},
            {"message", "Scenario compiled and ready in standby."},
            {"run_id", run_id_},
            {"seed", graph_->scenario().seed.decimal()},
            {"seed_hex", graph_->scenario().seed.hex()},
            {"lifecycle", "READY"}
        };
    } catch (...) {
        if (!lock.owns_lock()) lock.lock();
        preparing_stage_.store(0);
        if (generation == compile_generation_ && !terminate_requested_) {
            try { throw; } catch (const std::exception& error) { preparation_error_ = error.what(); } catch (...) { preparation_error_ = "World preparation failed."; }
            transition(Lifecycle::Idle);
        }
        throw;
    }
}

nlohmann::json SimulationEngine::signal_state_json() const {
    auto items = events_.signal_json(graph_->scenario(), virtual_s_);
    for (auto& item : items) {
        const auto node = item["junction_id"].get<std::uint32_t>();
        if (!signal_overrides_.contains(node)) { item["manual_override"] = false; continue; }
        const bool ns = signal_overrides_.at(node) == 1;
        item["manual_override"] = true;
        item["phase_name"] = ns ? "Override: north/south green" : "Override: east/west green";
        item["group_a"] = ns ? "green" : "red";
        item["group_b"] = ns ? "red" : "green";
        item["phase"] = ns ? 0 : 3;
        item["phase_started_at"] = nullptr;
        item["time_in_phase"] = nullptr;
        item["next_transition_at"] = nullptr;
    }
    return items;
}

nlohmann::json SimulationEngine::toggle_signal(NodeId node, std::optional<int> force_phase) {
    std::lock_guard lock(mutex_);
    if (!graph_ || node.value >= graph_->nodes().size()) throw std::invalid_argument("invalid node for signal toggle");
    if (force_phase && *force_phase != 1 && *force_phase != 2) throw std::invalid_argument("signal phase must be 1 or 2");
    const bool had_override = signal_overrides_.contains(node.value);
    int current_override = had_override ? signal_overrides_[node.value] : 1;
    int next_phase = force_phase.has_value() ? *force_phase : (current_override == 1 ? 2 : 1);
    signal_overrides_[node.value] = next_phase;
    ++config_revision_;
    // A null "before" phase means the signal was on its own timing plan, which
    // is what undo must give back rather than a forced phase 1.
    auto& c = record("signal_toggle",
                     {{"node", node.value}, {"phase", had_override ? nlohmann::json(current_override) : nlohmann::json(nullptr)}},
                     {{"node", node.value}, {"phase", next_phase}});
    add_news(c.id, "signals", "info", "SIGNAL_MANUAL_OVERRIDE",
             "[" + hhmmss(virtual_s_) + "] Manual controller override: Node #" + std::to_string(node.value) +
             " phase switched to " + (next_phase == 1 ? "Phase 1 (N-S Green / E-W Red)" : "Phase 2 (E-W Green / N-S Red)"),
             {{"node_id", node.value}, {"phase", next_phase}});
    return {
        {"command_id", c.id},
        {"node_id", node.value},
        {"phase", next_phase},
        {"phase_label", next_phase == 1 ? "PHASE_1_NS_GREEN" : "PHASE_2_EW_GREEN"}
    };
}

nlohmann::json SimulationEngine::trigger_surge(NodeId node, double factor, double radius_m, std::uint32_t duration_s) {
    std::lock_guard lock(mutex_);
    if (!graph_ || node.value >= graph_->nodes().size()) throw std::invalid_argument("invalid node for surge");
    if (!std::isfinite(factor) || factor <= 0 || factor > 10)
        throw std::invalid_argument("surge factor must be finite and in (0,10]");
    if (!std::isfinite(radius_m) || radius_m <= 0 || radius_m > 20000)
        throw std::invalid_argument("surge radius_m must be finite and in (0,20000]");
    if (duration_s == 0 || duration_s > day_s)
        throw std::invalid_argument("surge duration_s must be in [1,86400]");
    const auto surge_id = static_cast<std::uint32_t>(next_event_id_++);
    // Widened so a long surge late in the day cannot wrap past midnight.
    const auto end_s = static_cast<std::uint32_t>(std::min<std::uint64_t>(day_s, std::uint64_t(virtual_s_) + duration_s));
    active_surges_.push_back({surge_id, node, virtual_s_, end_s, factor, radius_m, "Commercial Demand Surge"});
    ++config_revision_;
    add_news(surge_id, "traffic", "warning", "TRAFFIC_SURGE_ACTIVE",
             "[" + hhmmss(virtual_s_) + "] Commercial demand surge active around Node #" + std::to_string(node.value) +
             " (+" + std::to_string(static_cast<int>((factor - 1.0) * 100)) + "% demand, radius " +
             std::to_string(static_cast<int>(radius_m)) + "m until " + hhmmss(end_s) + ")",
             {{"node_id", node.value}, {"factor", factor}, {"radius_m", radius_m}, {"end_time", hhmmss(end_s)}});
    return {
        {"surge_id", surge_id},
        {"node_id", node.value},
        {"factor", factor},
        {"radius_m", radius_m},
        {"start_time", hhmmss(virtual_s_)},
        {"end_time", hhmmss(end_s)}
    };
}

// Make a compiled scenario the active world: the graph, and the compute
// backends' resources for it. The old world's resources are released first.
// If an accelerator cannot take the new world it runs on the CPU, never half
// installed. Caller holds mutex_.
void SimulationEngine::adopt_world(Scenario scenario) {
    if (graph_) graph_->attach_dynamic_source(nullptr);
    graph_ = std::make_unique<GraphStore>(std::move(scenario));
    compute_->install(graph_->scenario());
    graph_->attach_dynamic_source(compute_.get());
}

void SimulationEngine::install_scenario(Scenario scenario, double tick_rate, std::uint32_t start) {
    installed_at_ = std::chrono::steady_clock::now();
    run_id_ = "run_" + scenario.scenario_hash.substr(7, 12);
    adopt_world(std::move(scenario));
    tick_rate_ = tick_rate;
    requested_tick_rate_ = tick_rate;
    asb_.reset();
    virtual_s_ = 0;
    start_virtual_s_ = std::min(start, day_s);
    manual_weather_.clear();
    active_surges_.clear();
    signal_overrides_.clear();
    news_.clear();
    commands_.clear();
    redo_.clear();
    checkpoints_.clear();
    next_command_id_ = 1;
    next_news_id_ = 1;
    next_event_id_ = 1'000'000;
    config_revision_ = 1;
    signal_by_node_.assign(graph_->scenario().nodes.size(), nullptr);
    for (const auto& sig : graph_->scenario().signals) {
        if (sig.node.value < signal_by_node_.size()) {
            signal_by_node_[sig.node.value] = &sig;
        }
    }
    events_.initialize(graph_->scenario());
    congestion_ = {};
    transition(Lifecycle::Ready);
    add_news(0, "system", "info", "SCENARIO_INITIALIZED",
             "[" + hhmmss(virtual_s_) + "] Scenario initialized with Seed " + graph_->scenario().seed.hex(),
             {{"scenario_hash", graph_->scenario().scenario_hash}});
    add_news(1, "system", "info", "NETWORK_TOPOLOGY_LOADED",
             "[" + hhmmss(virtual_s_) + "] Road network loaded: " + std::to_string(graph_->edges().size()) +
             " directional edges, " + std::to_string(graph_->nodes().size()) + " intersections.",
             {{"edges", graph_->edges().size()}, {"nodes", graph_->nodes().size()}});
    if (graph_->scenario().config.dws && !graph_->scenario().dws_events.empty()) {
        add_news(2, "weather", "info", "WEATHER_FORECAST",
                 "[" + hhmmss(virtual_s_) + "] Weather forecast: " + std::to_string(graph_->scenario().dws_events.size()) +
                 " rain storm events scheduled for today across network nodes.",
                 {{"event_count", graph_->scenario().dws_events.size()}});
        for (const auto& e : graph_->scenario().dws_events) {
            const auto ev_start = std::uint32_t(std::uint64_t(e.start_ppm) * day_s / ppm);
            add_news(e.id.value, "weather", "info", "DWS_RAIN_SCHEDULED",
                     "[" + hhmmss(virtual_s_) + "] Forecast: Rain storm scheduled at " + hhmmss(ev_start) + " around Node " +
                     std::to_string(e.epicenter.value) + " (Radius: " + std::to_string(static_cast<int>(e.radius_m)) + "m)",
                     {{"epicenter", e.epicenter.value}, {"radius_m", e.radius_m}, {"start_time", hhmmss(ev_start)}});
        }
    }
    if (graph_->scenario().config.signals && !graph_->scenario().signals.empty()) {
        add_news(3, "signals", "info", "SIGNALS_ONLINE",
                 "[" + hhmmss(virtual_s_) + "] Traffic light timing controllers online across " +
                 std::to_string(graph_->scenario().signals.size()) + " intersections.",
                 {{"signal_count", graph_->scenario().signals.size()}});
    }
    if (const auto& t = graph_->scenario().terrain) {
        const auto& p = t->provenance;
        std::ostringstream range;
        range << std::fixed << std::setprecision(1) << t->min_m << " to " << t->max_m << " m";
        if (p.degraded) {
            logger_.system("WARN", "terrain", "terrain.fallback flat terrain in use: " + p.note);
            add_news(5, "system", "warning", "TERRAIN_DEGRADED",
                     "[" + hhmmss(virtual_s_) + "] Terrain unavailable; the run uses flat terrain and is marked degraded.",
                     {{"reason", p.note}});
        } else {
            logger_.system("INFO", "terrain", "terrain.loaded source=" + p.source + (p.note.empty() ? "" : " (" + p.note + ")") +
                           " grid=" + std::to_string(t->grid.width) + "x" + std::to_string(t->grid.height) + " elevation " + range.str());
            if (p.source != "flat")
                add_news(5, "system", "info", "TERRAIN_LOADED",
                         "[" + hhmmss(virtual_s_) + "] Terrain loaded (" + p.source + "): elevation " + range.str() + ".",
                         {{"source", p.source}, {"min_m", t->min_m}, {"max_m", t->max_m}});
        }
    }
    add_news(4, "traffic", "info", "PHYSICS_ENGINE_ACTIVE",
             "[" + hhmmss(virtual_s_) + "] Aggregate traffic model active with deterministic queue dynamics.");
    capture_checkpoint();
    if (start_virtual_s_) restore_to(start_virtual_s_);
}

nlohmann::json SimulationEngine::start(Seed128 seed, const ScenarioConfig& config, std::uint32_t start) {
    auto compile_lease = std::make_shared<CompileLease>(compiling_);
    std::unique_lock lock(mutex_);
    if (terminate_requested_) throw std::logic_error("simulation is terminating");
    if (lifecycle_ == Lifecycle::Running || lifecycle_ == Lifecycle::Paused || lifecycle_ == Lifecycle::Preparing) {
        throw std::logic_error("a simulation is already active");
    }
    transition(Lifecycle::Preparing);
    const auto generation = ++compile_generation_;
    preparation_error_.clear();
    try {
        lock.unlock();
        auto scenario = compiler_.compile(seed, config, compile_progress());
        lock.lock();
        if (generation != compile_generation_ || terminate_requested_)
            throw std::logic_error("world preparation cancelled by runtime change");
        install_scenario(std::move(scenario), config.tick_rate, start);
        preparing_stage_.store(0);
        transition(Lifecycle::Running);
        anchor_wall_clock();
        cv_.notify_all();
        return {
            {"ok", true},
            {"message", "Simulation accepted and prepared."},
            {"run_id", run_id_},
            {"seed", graph_->scenario().seed.decimal()},
            {"seed_hex", graph_->scenario().seed.hex()},
            {"lifecycle", to_string(lifecycle_)},
            {"resolved_config", {
                {"playback_duration_seconds", config.playback_duration_s},
                {"tick_rate", tick_rate_},
                {"day", graph_->scenario().config.day},
                {"month", graph_->scenario().month}
            }},
            {"calendar", calendar_json(graph_->scenario())},
            {"stream", {
                {"snapshot", "/api/v1/view/snapshot"},
                {"bulk_stream", "/api/v1/view/stream"},
                {"news_stream", "/api/v1/news/stream"}
            }}
        };
    } catch (...) {
        if (!lock.owns_lock()) lock.lock();
        preparing_stage_.store(0);
        if (generation == compile_generation_ && !terminate_requested_) {
            try { throw; } catch (const std::exception& error) { preparation_error_ = error.what(); } catch (...) { preparation_error_ = "World preparation failed."; }
            transition(Lifecycle::Idle);
        }
        throw;
    }
}

nlohmann::json SimulationEngine::start_async(Seed128 seed, const ScenarioConfig& config, std::uint32_t start) {
    auto compile_lease = std::make_shared<CompileLease>(compiling_);
    std::uint64_t generation;
    {
        std::lock_guard lock(mutex_);
        if (terminate_requested_) throw std::logic_error("simulation is terminating");
        if (lifecycle_ == Lifecycle::Running || lifecycle_ == Lifecycle::Paused || lifecycle_ == Lifecycle::Preparing)
            throw std::logic_error("a simulation is already active");
        transition(Lifecycle::Preparing);
        generation = ++compile_generation_;
        preparation_error_.clear();
    }

    // Do not make the HTTP worker own map download latency. The same worker is
    // also used by regeneration, so the compile lease prevents overlap while
    // status and map-progress requests remain independently serviceable.
    world_worker_ = std::jthread([this, seed, config, start, generation, compile_lease](std::stop_token) {
        try {
            auto scenario = compiler_.compile(seed, config, compile_progress());
            std::lock_guard lock(mutex_);
            if (generation != compile_generation_ || terminate_requested_)
                throw std::logic_error("world preparation cancelled by runtime change");
            install_scenario(std::move(scenario), config.tick_rate, start);
            preparing_stage_.store(0);
            transition(Lifecycle::Running);
            anchor_wall_clock();
            cv_.notify_all();
        } catch (...) {
            std::lock_guard lock(mutex_);
            preparing_stage_.store(0);
            if (generation == compile_generation_ && !terminate_requested_) {
                try { throw; } catch (const std::exception& error) { preparation_error_ = error.what(); }
                catch (...) { preparation_error_ = "World preparation failed."; }
                transition(Lifecycle::Idle);
            }
        }
    });
    return {
        {"ok", true},
        {"api_version", "1.0"},
        {"run_id", ""},
        {"data", {
            {"accepted", true}, {"lifecycle", "PREPARING"}, {"seed", seed.decimal()}, {"seed_hex", seed.hex()}
        }}
    };
}

void SimulationEngine::check_playback_guard(const nlohmann::json& guard) const {
    if (guard.is_null()) return;
    if (!guard.is_object()) throw std::invalid_argument("playback guard must be an object");
    if (guard.contains("expected_playback_revision") && !guard.at("expected_playback_revision").is_number_unsigned())
        throw std::invalid_argument("expected_playback_revision must be a non-negative integer");
    if (guard.contains("expected_run_id") && guard.at("expected_run_id").get<std::string>() != run_id_)
        throw std::logic_error("run changed; playback action cancelled");
    if (guard.contains("expected_playback_revision") && guard.at("expected_playback_revision") != playback_revision_)
        throw std::logic_error("playback changed; action cancelled");
    if (guard.value("require_asb_normal", false) && asb_.state() != AsbState::Normal)
        throw std::logic_error("ASB intervention prevents automatic playback restoration");
}

nlohmann::json SimulationEngine::pause(const nlohmann::json& guard) {
    std::lock_guard lock(mutex_);
    check_playback_guard(guard);
    if (lifecycle_ == Lifecycle::Paused) {
        if (guard.empty()) ++playback_revision_; // An explicit pause supersedes a tutorial's lease.
        return {{"changed", false}, {"lifecycle", "PAUSED"}, {"playback_revision", playback_revision_}, {"run_id", run_id_}};
    }
    if (lifecycle_ != Lifecycle::Running) throw std::logic_error("simulation is not running");
    transition(Lifecycle::Paused);
    return {
        {"changed", true},
        {"lifecycle", "PAUSED"},
        {"playback_revision", playback_revision_}, {"run_id", run_id_},
        {"simulated_seconds", virtual_s_},
        {"state_revision", graph_->state_revision()}
    };
}

nlohmann::json SimulationEngine::play(const nlohmann::json& guard) {
    std::lock_guard lock(mutex_);
    check_playback_guard(guard);
    if (lifecycle_ == Lifecycle::Running) return {{"changed", false}, {"lifecycle", "RUNNING"}};
    if (lifecycle_ != Lifecycle::Paused) {
        throw std::logic_error("simulation cannot play from current lifecycle");
    }
    transition(Lifecycle::Running);
    anchor_wall_clock();
    cv_.notify_all();
    return {{"changed", true}, {"lifecycle", "RUNNING"}, {"simulated_seconds", virtual_s_}};
}

nlohmann::json SimulationEngine::stop() {
    std::lock_guard lock(mutex_);
    if (!graph_) return {{"changed", false}, {"lifecycle", to_string(lifecycle_)}};
    transition(Lifecycle::Stopping);
    transition(Lifecycle::Stopped);
    return {{"changed", true}, {"lifecycle", "STOPPED"}, {"run_id", run_id_}, {"simulated_seconds", virtual_s_}};
}

nlohmann::json SimulationEngine::reset() {
    std::lock_guard lock(mutex_);
    ++compile_generation_;
    preparation_error_.clear();
    if (lifecycle_ == Lifecycle::Running || lifecycle_ == Lifecycle::Paused) stop();
    graph_.reset();
    compute_->release();
    run_id_.clear();
    virtual_s_ = 0;
    start_virtual_s_ = 0;
    manual_weather_.clear();
    active_surges_.clear();
    signal_overrides_.clear();
    signal_by_node_.clear();
    events_ = {}; congestion_ = {};
    news_.clear();
    commands_.clear();
    redo_.clear();
    checkpoints_.clear();
    next_command_id_ = 1;
    next_news_id_ = 1;
    next_event_id_ = 1'000'000;
    config_revision_ = 0;
    asb_.reset();
    tick_rate_ = requested_tick_rate_ = 1.0;
    transition(Lifecycle::Idle);
    return {{"ok", true}, {"lifecycle", "IDLE"}};
}

nlohmann::json SimulationEngine::seek(std::uint32_t target, bool resume) {
    std::lock_guard lock(mutex_);
    if (!graph_ || target > day_s) throw std::invalid_argument("target time outside virtual day");
    if (lifecycle_ == Lifecycle::Terminating || lifecycle_ == Lifecycle::Preparing)
        throw std::logic_error("simulation cannot seek from current lifecycle");
    const auto was_running = lifecycle_ == Lifecycle::Running;
    transition(Lifecycle::Seeking);
    if (target >= virtual_s_) step_to(target);
    else restore_to(target);
    // The end of the day is the end of the run, however it was reached.
    if (virtual_s_ >= day_s) transition(Lifecycle::Completed);
    else transition((resume || was_running) ? Lifecycle::Running : Lifecycle::Paused);
    anchor_wall_clock();
    cv_.notify_all();
    return {
        {"target_time", hhmmss(target)},
        {"simulated_seconds", target},
        {"lifecycle", to_string(lifecycle_)},
        {"state_revision", graph_->state_revision()}
    };
}

nlohmann::json SimulationEngine::step(std::uint32_t seconds) {
    std::lock_guard lock(mutex_);
    if (!graph_) throw std::logic_error("no active simulation");
    if (seconds == 0 || seconds > 3600) throw std::invalid_argument("step seconds must be in [1, 3600]");
    if (lifecycle_ == Lifecycle::Terminating || lifecycle_ == Lifecycle::Preparing)
        throw std::logic_error("simulation cannot step from current lifecycle");
    if (virtual_s_ >= day_s) throw std::logic_error("simulation has reached the end of the virtual day");
    const auto from = virtual_s_;
    transition(Lifecycle::Seeking);
    step_to(std::min(day_s, virtual_s_ + seconds));
    // A step always leaves the run paused; the last one completes the day.
    transition(virtual_s_ >= day_s ? Lifecycle::Completed : Lifecycle::Paused);
    anchor_wall_clock();
    cv_.notify_all();
    return {
        {"from_seconds", from},
        {"simulated_seconds", virtual_s_},
        {"stepped_seconds", virtual_s_ - from},
        {"target_time", hhmmss(virtual_s_)},
        {"lifecycle", to_string(lifecycle_)},
        {"playback_revision", playback_revision_},
        {"state_revision", graph_->state_revision()}
    };
}

nlohmann::json SimulationEngine::regenerate_world(const nlohmann::json& request) {
    auto compile_lease = std::make_shared<CompileLease>(compiling_);
    std::uint64_t compile_generation;
    // Short enough for an operator to read off the screen and retype. The
    // observer may name the seed (one it generated under constraints, or one
    // the operator typed); it never names the configuration.
    Seed128 seed = Seed128::secure64();
    if (request.is_object() && request.contains("seed") && !request.at("seed").is_null()) {
        const auto& value = request.at("seed");
        if (!value.is_string()) throw std::invalid_argument("seed must be a decimal string");
        const auto text = value.get<std::string>();
        if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
            throw std::invalid_argument("seed must be a decimal integer");
        seed = Seed128::from_decimal(text);
        if (seed == Seed128{}) throw std::invalid_argument("seed must not be zero");
    }
    ScenarioConfig config;
    std::string previous;
    double rate = 1.0;
    {
        std::lock_guard lock(mutex_);
        if (!request.is_null() && !request.is_object()) throw std::invalid_argument("request must be an object");
        if (!graph_) throw std::logic_error("no active simulation to regenerate");
        if (terminate_requested_ || lifecycle_ == Lifecycle::Terminating) throw std::logic_error("simulation is terminating");
        if (request.is_object() && request.contains("expected_run_id") &&
            request.at("expected_run_id").get<std::string>() != run_id_)
            throw std::logic_error("run changed; world generation cancelled");
        // The world is about to be replaced: stop it advancing first, so no
        // physics, events or backpressure are evaluated against a world that
        // is on its way out.
        if (lifecycle_ == Lifecycle::Running) {
            transition(Lifecycle::Paused);
            ++playback_revision_;
        }
        config = graph_->scenario().config;
        // Derive the calendar afresh for the new seed unless this run's
        // configuration named it.
        config.day = graph_->scenario().requested_day;
        config.month = graph_->scenario().requested_month;
        // A seed-selected world stores the path of the tile it resolved to.
        // Re-rolling must let the new seed choose its own place, so restore
        // the "auto" source; an operator-pinned map file stays pinned.
        if (!graph_->scenario().map_city.empty()) config.osm_file = "auto";
        previous = run_id_;
        rate = requested_tick_rate_;
        compile_generation = ++compile_generation_;
    }
    config.tick_rate = rate;
    std::lock_guard job_lock(world_mutex_);
    if (world_job_.state == "generating") throw std::logic_error("world generation already in progress");
    world_job_ = WorldJob{};
    world_job_.state = "generating";
    world_job_.stage = "compiling";
    world_job_.seed = seed.decimal();
    world_job_.seed_hex = seed.hex();
    world_job_.previous_run_id = previous;
    world_job_.generation = ++world_generation_counter_;
    world_job_.started = std::chrono::steady_clock::now();
    world_generating_.store(true);
    const auto generation = world_job_.generation;
    logger_.system("INFO", "world", "Generating new world with seed " + seed.hex());
    // Assigning joins the previous (already finished) worker, if any.
    world_worker_ = std::jthread([this, seed, config, generation, compile_generation, compile_lease](std::stop_token) {
        auto fail = [&](const std::string& code, const std::string& message) {
            world_generating_.store(false);
            preparing_stage_.store(0);
            std::lock_guard l(world_mutex_);
            if (world_job_.generation != generation) return;
            world_job_.state = "failed";
            world_job_.stage = "failed";
            world_job_.error_code = code;
            world_job_.error = message;
            world_job_.finished = std::chrono::steady_clock::now();
            logger_.system("ERROR", "world", code + ": " + message);
        };
        try {
            auto scenario = compiler_.compile(seed, config, compile_progress());
            {
                std::lock_guard l(world_mutex_);
                world_job_.stage = "installing";
            }
            std::string run;
            {
                std::lock_guard lock(mutex_);
                if (terminate_requested_ || compile_generation != compile_generation_)
                    return fail("WORLD_CANCELLED", "Runtime changed before the world was ready; the replacement was not installed.");
                transition(Lifecycle::Preparing);
                install_scenario(std::move(scenario), config.tick_rate, 0);
                // A regenerated world waits for the operator rather than
                // running away while its map is still being drawn.
                transition(Lifecycle::Paused);
                anchor_wall_clock();
                cv_.notify_all();
                run = run_id_;
            }
            // The swap is complete: backpressure may judge the new world from
            // the next report onwards.
            preparing_stage_.store(0);
            world_generating_.store(false);
            std::lock_guard l(world_mutex_);
            if (world_job_.generation != generation) return;
            world_job_.state = "ready";
            world_job_.stage = "ready";
            world_job_.run_id = run;
            world_job_.finished = std::chrono::steady_clock::now();
            logger_.system("INFO", "world", "World " + run + " ready");
        } catch (const MapFetchError& e) {
            fail("MAP_FETCH_FAILED", e.what());
        } catch (const std::exception& e) {
            fail("WORLD_GENERATION_FAILED", e.what());
        }
    });
    return world_status_locked();
}

nlohmann::json SimulationEngine::world_status() const {
    std::lock_guard lock(world_mutex_);
    return world_status_locked();
}

nlohmann::json SimulationEngine::world_status_locked() const {
    const auto& j = world_job_;
    const auto end = j.state == "generating" ? std::chrono::steady_clock::now() : j.finished;
    const double elapsed = j.state == "idle" ? 0.0 : std::chrono::duration<double>(end - j.started).count();
    auto stage = j.stage;
    nlohmann::json map = nullptr;
    if (j.state == "generating" && j.stage == "compiling") {
        // Compilation spends most of its time fetching the map; report that
        // phase exactly as the downloader does rather than estimating it.
        const auto fetch = current_map_fetch();
        if (fetch.active) {
            stage = fetch.phase == "parse" ? "validating" : fetch.phase == "download" ? "downloading" : "requesting";
            map = {{"city", fetch.city}, {"country", fetch.country}, {"phase", fetch.phase},
                   {"bytes", fetch.bytes}, {"total", fetch.total}, {"elapsed_s", fetch.elapsed_s}};
        } else {
            stage = "building";
        }
    }
    nlohmann::json error = nullptr;
    if (j.state == "failed") error = {{"code", j.error_code}, {"message", j.error}};
    return {
        {"api_version", "1.0"},
        {"data", {
            {"state", j.state},
            {"stage", stage},
            {"seed", j.seed},
            {"seed_hex", j.seed_hex},
            {"previous_run_id", j.previous_run_id},
            {"run_id", j.run_id},
            {"generation", j.generation},
            {"elapsed_s", elapsed},
            {"map", map},
            {"error", error}
        }}
    };
}

AppliedCommand& SimulationEngine::record(std::string type, nlohmann::json before, nlohmann::json after) {
    redo_.clear();
    commands_.push_back({next_command_id_++, std::move(type), "applied", virtual_s_, std::move(before), std::move(after)});
    logger_.event(run_id_, commands_.back().id, "control", "applied", virtual_s_, dump_json(commands_.back().after));
    return commands_.back();
}

// How long after a world is installed backpressure ignores what it is told.
// One report interval is 1 s, so this covers the report in flight across the
// swap and the first one after it without hiding a genuinely slow interface.
constexpr double kWorldSettleS = 3.0;

// Publishes what a compile is doing, so a wait can be explained while the
// engine lock is held.
ScenarioCompiler::Progress SimulationEngine::compile_progress() {
    return [this](ScenarioCompiler::Stage stage) {
        preparing_stage_.store(stage == ScenarioCompiler::Stage::Selecting   ? 1
                               : stage == ScenarioCompiler::Stage::Acquiring ? 2
                                                                             : 3);
    };
}

std::string SimulationEngine::preparation_stage() const {
    switch (preparing_stage_.load()) {
        case 1: return "selecting";
        case 2: return "acquiring";
        case 3: return "building";
        default: return "";
    }
}

double SimulationEngine::asb_now() const {
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - asb_epoch_).count();
}

nlohmann::json SimulationEngine::report_backpressure(double virtual_lag_s, double client_frame_s,
                                                     double since_poll_s) {
    std::lock_guard lock(mutex_);
    if (!std::isfinite(virtual_lag_s) || virtual_lag_s < 0)
        throw std::invalid_argument("virtual_lag_s must be finite and non-negative");
    if (!std::isfinite(client_frame_s) || client_frame_s < 0)
        throw std::invalid_argument("client_frame_s must be finite and non-negative");
    if (!std::isfinite(since_poll_s) || since_poll_s < 0)
        throw std::invalid_argument("since_poll_s must be finite and non-negative");
    const auto now = asb_now();
    // While a world is being prepared the observer is looking at a paused
    // world and will shortly be handed another one. Lag measured across that
    // swap says nothing about the interface keeping up, so it is not observed
    // and the window is cleared rather than left to decay into a false alarm.
    // The settling window also covers the report that was already in flight
    // when the swap completed, which describes the world that has just gone.
    const auto since_install = std::chrono::duration<double>(std::chrono::steady_clock::now() - installed_at_).count();
    if (lifecycle_ == Lifecycle::Preparing || world_generating_.load() || since_install < kWorldSettleS) {
        asb_.reset();
        return backpressure_json();
    }
    asb_.observe({virtual_lag_s, client_frame_s, since_poll_s, requested_tick_rate_}, now);
    // Apply whatever ASB now permits, without losing the operator's request.
    const auto governed = asb_.govern_tick_rate(requested_tick_rate_, now);
    if (governed != tick_rate_) {
        catch_up_to_wall_clock();
        tick_rate_ = governed;
        ++config_revision_;
        anchor_wall_clock();
    }
    return backpressure_json();
}

void SimulationEngine::note_delivery(std::size_t bytes) {
    std::lock_guard lock(mutex_);
    asb_.record_delivery(bytes, asb_now());
}

nlohmann::json SimulationEngine::backpressure() const {
    std::lock_guard lock(mutex_);
    return backpressure_json();
}

nlohmann::json SimulationEngine::backpressure_json() const {
    const auto s = asb_.status(asb_now());
    auto actions = nlohmann::json::array();
    for (const auto& a : s.recent_actions)
        actions.push_back({{"at_s", a.at_monotonic_s}, {"action", a.action}, {"reason", a.reason},
                           {"score", a.score}, {"rate_before", std::isfinite(a.tick_rate_before) ? a.tick_rate_before : -1.0},
                           {"rate_after", std::isfinite(a.tick_rate_after) ? a.tick_rate_after : -1.0}});
    return {
        {"state", to_string(s.state)},
        {"score", s.score},
        {"raw_score", s.raw_score},
        {"synced", s.synced},
        {"rate_locked", s.rate_locked},
        {"motion_locked", s.motion_locked},
        {"gui_suspended", s.gui_suspended},
        {"rate_capped", s.rate_capped},
        {"rate_cap", std::isfinite(s.rate_cap) ? s.rate_cap : -1.0},
        {"applied_tick_rate", tick_rate_},
        {"requested_tick_rate", requested_tick_rate_},
        {"stressed_for_s", s.stressed_for_s},
        {"state_for_s", s.state_for_s},
        {"throughput", {{"snapshots_per_s", s.snapshots_per_s}, {"bytes_per_s", s.bytes_per_s}}},
        {"actions", actions},
        {"thresholds", {{"synced", kAsbSyncedScore}, {"stressed", kAsbStressedScore},
                        {"critical", kAsbCriticalScore}, {"escalate_after_s", kAsbEscalateAfterS},
                        {"restricted_hold_s", kAsbRestrictedHoldS}, {"recover_after_s", kAsbRecoverAfterS}}}
    };
}

nlohmann::json SimulationEngine::set_tick_rate(double v) {
    std::lock_guard lock(mutex_);
    if (!std::isfinite(v) || v <= 0 || v > kMaxTickRate) throw std::invalid_argument("tick_rate must be finite and in (0,5]");
    catch_up_to_wall_clock();
    const auto old = tick_rate_;
    const auto old_request = requested_tick_rate_;
    requested_tick_rate_ = v;
    // ASB may hold the applied rate below the request while the observer is
    // behind. The request is remembered so the rate returns on its own once
    // synchronization recovers, rather than needing the operator to re-ask.
    tick_rate_ = asb_.govern_tick_rate(v, asb_now());
    ++config_revision_;
    auto& c = record("tick_rate", {{"tick_rate", old_request}}, {{"tick_rate", requested_tick_rate_}});
    anchor_wall_clock();
    return {
        {"command_id", c.id},
        {"previous_tick_rate", old},
        {"tick_rate", tick_rate_},
        {"requested_tick_rate", v},
        {"rate_governed_by_asb", tick_rate_ < v},
        {"base_rate", graph_ ? day_s / double(graph_->scenario().config.playback_duration_s) : 0},
        {"target_virtual_rate", graph_ ? day_s / double(graph_->scenario().config.playback_duration_s) * tick_rate_ : 0}
    };
}

nlohmann::json SimulationEngine::set_day(int v) {
    std::lock_guard lock(mutex_);
    if (v != 0 && v != 1) throw std::invalid_argument("day must be 0 or 1");
    if (!graph_) throw std::logic_error("no active simulation");
    const auto old = graph_->scenario().config.day;
    const_cast<ScenarioConfig&>(graph_->scenario().config).day = v;
    events_.initialize(graph_->scenario());
    (void)events_.advance(graph_->scenario(),virtual_s_);
    ++config_revision_;
    auto& c = record("day", {{"day", old}}, {{"day", v}});
    add_news(c.id, "control", "info", "DAY_CHANGED",
             "[" + hhmmss(virtual_s_) + "] Day mode changed to " + std::string(v ? "weekend" : "weekday"));
    return {{"command_id", c.id}, {"previous_day", old}, {"day", v}, {"config_revision", config_revision_}};
}

nlohmann::json SimulationEngine::set_module(const std::string& m, bool enabled) {
    std::lock_guard lock(mutex_);
    if (!graph_) throw std::logic_error("no active simulation");
    auto& cfg = const_cast<ScenarioConfig&>(graph_->scenario().config);
    bool* field = nullptr;
    if (m == "traffic") field = &cfg.traffic;
    else if (m == "signals") field = &cfg.signals;
    else if (m == "buildings") field = &cfg.buildings;
    else if (m == "dws") field = &cfg.dws;
    else if (m == "flooding") field = &cfg.flooding;
    else if (m == "news") field = &cfg.news;
    else throw std::invalid_argument("unknown module: " + m);
    const auto old = *field;
    *field = enabled;
    ++config_revision_;
    auto& c = record("module", {{"module", m}, {"enabled", old}}, {{"module", m}, {"enabled", enabled}});
    add_news(c.id, "control", "info", enabled ? "MODULE_ENABLED" : "MODULE_DISABLED",
             "[" + hhmmss(virtual_s_) + "] Module " + m + (enabled ? " was enabled" : " was disabled"));
    return {
        {"command_id", c.id},
        {"module", m},
        {"previous_enabled", old},
        {"enabled", enabled},
        {"config_revision", config_revision_}
    };
}

nlohmann::json SimulationEngine::add_weather(NodeId epicenter, double intensity, double radius, std::uint32_t duration, double gain) {
    std::lock_guard lock(mutex_);
    if (!graph_ || epicenter.value >= graph_->nodes().size()) throw std::invalid_argument("unknown epicenter node");
    if (!std::isfinite(intensity) || !std::isfinite(radius) || !std::isfinite(gain) || intensity < 0 || intensity > 1 || radius <= 0 || duration == 0 || duration > 1440 || gain < 0 || gain > 1) {
        throw std::invalid_argument("invalid weather parameters");
    }
    const auto playback_now = virtual_s_ * graph_->scenario().config.playback_duration_s / double(day_s);
    double last = -1e9;
    for (const auto& e : manual_weather_) {
        last = std::max(last, e.start_ppm / 1e6 * graph_->scenario().config.playback_duration_s);
    }
    const auto effective = std::max(playback_now, last + 5);
    const auto start = std::uint32_t(std::min(1.0, effective / graph_->scenario().config.playback_duration_s) * ppm);
    DwsEvent e{{next_event_id_++}, epicenter, start, std::min(ppm, start + std::uint32_t(duration / 1440.0 * ppm)), intensity, radius, gain, .12};
    manual_weather_.push_back(e);
    auto& c = record("manual_weather", {{"active", false}, {"event_id", e.id.value}, {"intensity", 0.0}}, {{"active", true}, {"event_id", e.id.value}, {"intensity", intensity}});
    add_news(e.id.value, "weather", "info", "DWS_RAIN_SCHEDULED",
             "[" + hhmmss(virtual_s_) + "] Manual rain scheduled at Node " + std::to_string(epicenter.value),
             {{"epicenter", epicenter.value}, {"radius_m", radius}, {"intensity", intensity}});
    return {
        {"command_id", c.id},
        {"event_id", e.id.value},
        {"status", "scheduled"},
        {"requested_start_playback_s", playback_now},
        {"effective_start_playback_s", effective},
        {"delayed_by_dws_gate", effective > playback_now + .0001}
    };
}

nlohmann::json SimulationEngine::override_edge(EdgeId id, double sm, double cm, bool closed) {
    std::lock_guard lock(mutex_);
    if (!graph_ || id.value >= graph_->edges().size()) throw std::invalid_argument("unknown edge");
    if (!std::isfinite(sm) || !std::isfinite(cm) || sm < 0 || sm > 2 || cm < 0 || cm > 2) {
        throw std::invalid_argument("multipliers must be finite and in [0,2]");
    }
    const auto previous = compute_->manual(id.value);
    nlohmann::json before{{"edge", id.value}, {"speed_multiplier", previous.speed_multiplier}, {"capacity_multiplier", previous.capacity_multiplier}, {"closed", previous.closed}};
    compute_->set_manual(id.value, {sm, cm, closed});
    graph_->commit();
    auto& c = record("edge_override", before, {{"edge", id.value}, {"speed_multiplier", sm}, {"capacity_multiplier", cm}, {"closed", closed}});
    return {{"command_id", c.id}, {"edge_id", id.value}, {"state_revision", graph_->state_revision()}};
}

void SimulationEngine::apply_command(const AppliedCommand& c, bool forward) {
    const auto& v = forward ? c.after : c.before;
    if (c.type == "tick_rate") {
        catch_up_to_wall_clock();
        requested_tick_rate_ = v.at("tick_rate");
        tick_rate_ = asb_.govern_tick_rate(requested_tick_rate_, asb_now());
        anchor_wall_clock();
    } else if (c.type == "day") {
        const_cast<ScenarioConfig&>(graph_->scenario().config).day = v.at("day");
        events_.initialize(graph_->scenario());
        (void)events_.advance(graph_->scenario(),virtual_s_);
    } else if (c.type == "module") {
        const auto m = v.at("module").get<std::string>();
        const auto enabled = v.at("enabled").get<bool>();
        auto& cfg = const_cast<ScenarioConfig&>(graph_->scenario().config);
        if (m == "traffic") cfg.traffic = enabled;
        else if (m == "signals") cfg.signals = enabled;
        else if (m == "buildings") cfg.buildings = enabled;
        else if (m == "dws") cfg.dws = enabled;
        else if (m == "flooding") cfg.flooding = enabled;
        else if (m == "news") cfg.news = enabled;
    } else if (c.type == "edge_override") {
        compute_->set_manual(v.at("edge").get<std::uint32_t>(),
                             {v.at("speed_multiplier").get<double>(), v.at("capacity_multiplier").get<double>(), v.at("closed").get<bool>()});
    } else if (c.type == "signal_toggle") {
        const auto node = v.at("node").get<std::uint32_t>();
        if (v.at("phase").is_null()) signal_overrides_.erase(node);
        else signal_overrides_[node] = v.at("phase").get<int>();
        ++config_revision_;
    } else if (c.type == "manual_weather") {
        const auto id = c.after.at("event_id").get<std::uint64_t>();
        for (auto& e : manual_weather_) {
            if (e.id.value == id) e.intensity = v.at("intensity");
        }
    }
    graph_->commit();
}

nlohmann::json SimulationEngine::undo(std::uint32_t count) {
    std::lock_guard lock(mutex_);
    std::vector<std::uint64_t> ids;
    while (count-- && !commands_.empty()) {
        auto c = commands_.back();
        commands_.pop_back();
        apply_command(c, false);
        c.status = "undone";
        ids.push_back(c.id);
        redo_.push_back(std::move(c));
    }
    return {{"undone", ids}, {"undo_depth", commands_.size()}, {"redo_depth", redo_.size()}};
}

nlohmann::json SimulationEngine::redo(std::uint32_t count) {
    std::lock_guard lock(mutex_);
    std::vector<std::uint64_t> ids;
    while (count-- && !redo_.empty()) {
        auto c = redo_.back();
        redo_.pop_back();
        apply_command(c, true);
        c.status = "applied";
        ids.push_back(c.id);
        commands_.push_back(std::move(c));
    }
    return {{"redone", ids}, {"undo_depth", commands_.size()}, {"redo_depth", redo_.size()}};
}

void SimulationEngine::physics_step(std::uint32_t dt) {
    if (!graph_) return;
    const auto& sc = graph_->scenario();
    const auto now_ppm = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);
    for(const auto& event:events_.advance(sc,virtual_s_)) {
        if(sc.config.buildings) add_news(event.sequence,"demand",event.value>1?"warning":"info","DEMAND_CHANGED",event.description,{{"feature_id",sc.features[event.entity].id},{"multiplier",event.value}});
    }
    const auto day_profile = std::sin((double(virtual_s_) / day_s * 2 * 3.141592653589793) - 1.2) * .5 + .5;

    // Describe the step in model units. The storm and surge curves involve
    // trigonometry, so they are evaluated here, once per step, on the CPU; the
    // compute backend receives their positions, radii and strengths.
    compute::StepRequest request;
    request.virtual_s = virtual_s_;
    request.dt = dt;
    request.day_profile = day_profile;
    request.traffic = sc.config.traffic;
    request.signals = sc.config.signals;
    request.buildings = sc.config.buildings;
    request.flooding = sc.config.flooding;
    if (sc.config.dws) {
        auto consider = [&](const DwsEvent& e) {
            if (e.epicenter.value >= sc.nodes.size()) return;
            const auto storm = evaluate_storm_state(e, now_ppm, sc.nodes[e.epicenter.value]);
            if (storm.active) request.storms.push_back({storm.cur_x_m, storm.cur_y_m, storm.cur_radius_m, storm.cur_intensity});
        };
        for (const auto& e : sc.dws_events) consider(e);
        for (const auto& e : manual_weather_) consider(e);
    }
    // Active surges follow a smooth bell over their lifetime.
    for (const auto& s : active_surges_) {
        if (virtual_s_ >= s.start_s && virtual_s_ <= s.end_s && s.end_s > s.start_s && s.node.value < sc.nodes.size()) {
            const double rel_t = double(virtual_s_ - s.start_s) / double(s.end_s - s.start_s);
            const double bell = std::sin(3.141592653589793 * rel_t);
            const double bell_weight = bell * bell;
            request.surges.push_back({s.node.value, 1.0 + (s.factor - 1.0) * bell_weight, s.radius_m * (0.35 + 0.65 * bell_weight)});
        }
    }
    for (std::size_t i = 0; i < events_.signals.size(); ++i)
        compute_->set_signal_phase(static_cast<std::uint32_t>(i), events_.signals[i].phase);
    compute_->sync_signal_overrides(signal_overrides_);
    for (const auto e : events_.demand_support())
        compute_->set_attraction(e, events_.demand_effect(EdgeId{e}));
    compute_->update_incidents(sc, virtual_s_, sc.config.incidents);

    const auto outcome = compute_->step(request);

    // Flood events, in edge order, exactly as the step reported them.
    if (outcome.transitions) {
        for (const auto& e : sc.edges) {
            if (!compute_->flood_transition(e.id.value)) continue;
            const double flood = compute_->edge_flood(e.id.value);
            const bool flooded = flood > .01;
            events_.observe({virtual_s_,e.id.value,0,0,"flooding",flooded?"Road becomes flood affected":"Flood effect cleared",flood});
            if(flooded && e.id.value%2==0) add_news(800000+e.id.value,"flooding","warning","FLOOD_STARTED","Flooding detected on Edge "+std::to_string(e.id.value),{{"edge_id",e.id.value},{"flood",flood}});
        }
    }

    const auto previous = virtual_s_ >= dt ? virtual_s_ - dt : 0;
    auto notify = [&](const DwsEvent& e) {
        const auto start = std::uint32_t(std::uint64_t(e.start_ppm) * day_s / ppm);
        const auto end = std::uint32_t(std::uint64_t(e.end_ppm) * day_s / ppm);
        const auto peak = start + (end - start) / 2;
        if (previous < start && virtual_s_ >= start) {
            add_news(e.id.value, "weather", "warning", "DWS_RAIN_STARTED",
                     "[" + hhmmss(start) + "] Rain storm initiated at Node " + std::to_string(e.epicenter.value) +
                     " (Radius: " + std::to_string(static_cast<int>(e.radius_m)) + "m, Intensity: " +
                     std::to_string(static_cast<int>(e.intensity * 100)) + "%)",
                     {{"epicenter", e.epicenter.value}, {"radius_m", e.radius_m}, {"intensity", e.intensity}});
        }
        if (previous < peak && virtual_s_ >= peak && peak > start) {
            add_news(e.id.value + 50000, "weather", "alert", "DWS_RAIN_PEAK",
                     "[" + hhmmss(peak) + "] Peak precipitation & runoff at Node " + std::to_string(e.epicenter.value) +
                     "; road friction reduced.",
                     {{"epicenter", e.epicenter.value}, {"intensity", e.intensity}});
        }
        if (previous < end && virtual_s_ >= end) {
            add_news(e.id.value + 100000, "weather", "info", "DWS_RAIN_ENDED",
                     "[" + hhmmss(end) + "] Rain storm cleared at Node " + std::to_string(e.epicenter.value) +
                     "; network returning to baseline conditions.");
        }
    };
    if (sc.config.dws) {
        for (const auto& e : sc.dws_events) notify(e);
        for (const auto& e : manual_weather_) notify(e);
    }

    // Active Deterministic Incident Lifecycle (Activation & Resolution)
    if (sc.config.incidents) {
        for (const auto& inc : sc.incidents) {
            if (previous < inc.start_virtual_s && virtual_s_ >= inc.start_virtual_s) {
                std::string sev = "warning";
                if (inc.type == IncidentType::RoadClosure || inc.type == IncidentType::HazardSpill) sev = "alert";
                else if (inc.type == IncidentType::Congestion) sev = "info";
                add_news(inc.id, "incident", sev, "INCIDENT_ACTIVATED",
                         "[" + hhmmss(inc.start_virtual_s) + "] " + inc.description + " on Edge #" + std::to_string(inc.edge.value) +
                         " near Node #" + std::to_string(inc.node.value) + ". (" + (sev == "alert" ? "HIGH" : (sev == "warning" ? "MID" : "LOW")) + " SEVERITY)",
                         {{"incident_id", inc.id},
                          {"type", to_string(inc.type)},
                          {"edge_id", inc.edge.value},
                          {"node_id", inc.node.value},
                          {"speed_multiplier", inc.speed_multiplier},
                          {"capacity_multiplier", inc.capacity_multiplier},
                          {"closed", inc.closed},
                          {"end_virtual_s", inc.end_virtual_s}});
            }
            if (previous < inc.end_virtual_s && virtual_s_ >= inc.end_virtual_s) {
                add_news(inc.id + 500000, "incident", "info", "INCIDENT_RESOLVED",
                         "[" + hhmmss(inc.end_virtual_s) + "] Incident cleared on Edge #" + std::to_string(inc.edge.value) +
                         " (" + to_string(inc.type) + "): Normal traffic flow restored.",
                         {{"incident_id", inc.id},
                          {"type", to_string(inc.type)},
                          {"edge_id", inc.edge.value},
                          {"node_id", inc.node.value}});
            }
        }
    }

    congestion_.record(outcome.congestion_index,virtual_s_,dt);
    // Places respond to the conditions this tick produced: roads shut, rain
    // falling, an incident nearby. Run last, so couplings read the same state
    // the operator is about to be shown rather than the previous tick's.
    events_.recouple(sc,compute_->conditions(),virtual_s_);
    graph_->commit();
}

void SimulationEngine::step_to(std::uint32_t target) {
    target = std::min(target, day_s);
    while (virtual_s_ < target) {
        const auto to_checkpoint = 900 - (virtual_s_ % 900);
        const auto dt = std::min({std::uint32_t{1}, target - virtual_s_, to_checkpoint});
        virtual_s_ += dt;
        try {
            physics_step(dt);
        } catch (const compute::StateLost& lost) {
            logger_.system("ERROR", "compute", std::string("compute.device_lost ") + lost.what());
            recover_compute(virtual_s_);
        }
        if (virtual_s_ % 900 == 0) {
            capture_checkpoint();
        }
    }
    if (virtual_s_ >= day_s && lifecycle_ == Lifecycle::Running) {
        transition(Lifecycle::Completed);
    }
}

void SimulationEngine::capture_checkpoint() {
    std::vector<std::uint32_t> physics;
    try {
        physics = compute_->export_state();
    } catch (const compute::StateLost& lost) {
        logger_.system("ERROR", "compute", std::string("compute.device_lost ") + lost.what());
        recover_compute(virtual_s_);
        physics = compute_->export_state();
    }
    Checkpoint checkpoint{virtual_s_, std::move(physics), news_.size(), next_news_id_, events_, congestion_};
    const auto position = std::lower_bound(checkpoints_.begin(), checkpoints_.end(), virtual_s_, [](const Checkpoint& value, auto time) {
        return value.virtual_s < time;
    });
    if (position != checkpoints_.end() && position->virtual_s == virtual_s_) {
        *position = std::move(checkpoint);
    } else {
        checkpoints_.insert(position, std::move(checkpoint));
    }
}

void SimulationEngine::restore_to(std::uint32_t target) {
    auto it = std::upper_bound(checkpoints_.begin(), checkpoints_.end(), target, [](auto t, const Checkpoint& c) {
        return t < c.virtual_s;
    });
    if (it != checkpoints_.begin()) --it;
    // Operator edge overrides stand until they are undone, as signal overrides
    // and surges do. They are inputs held by the compute dispatcher, outside
    // the checkpointed state, so restoring a checkpoint taken before one was
    // made does not erase it.
    graph_->reset_dynamic();
    virtual_s_ = 0;
    if (it != checkpoints_.end()) {
        virtual_s_ = it->virtual_s;
        compute_->import_state(it->physics);
        if (news_.size() > it->news_size) news_.resize(it->news_size);
        next_news_id_ = it->next_news_id;
        events_ = it->events; congestion_ = it->congestion;
        checkpoints_.erase(std::next(it), checkpoints_.end());
    } else {
        compute_->reset_state();
    }
    step_to(target);
}

// The accelerator failed and took the state of this step with it. The
// checkpoints are host copies, and the step is deterministic, so replaying
// from the latest one on the CPU reaches exactly the state that was lost.
void SimulationEngine::recover_compute(std::uint32_t target) {
    logger_.system("WARN", "compute", "compute.recovery replaying to " + hhmmss(target) + " on the CPU from the latest checkpoint");
    compute_->recovered();
    restore_to(target);
}

void SimulationEngine::loop() {
    std::unique_lock lock(mutex_);
    while (!terminate_requested_) {
        cv_.wait_for(lock, std::chrono::milliseconds(50));
        if (terminate_requested_) break;
        if (!graph_) continue;
        if (compute_->needs_recovery()) recover_compute(virtual_s_);

        if (lifecycle_ == Lifecycle::Running) {
            const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - anchor_wall_).count();
            const auto rate = day_s / double(graph_->scenario().config.playback_duration_s) * tick_rate_;
            step_to(std::min(day_s, anchor_virtual_s_ + static_cast<std::uint32_t>(elapsed * rate)));
        }

        const auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last_global_dump_).count() >= 10.0) {
            last_global_dump_ = now;
            try {
                const auto gv = global_view();
                logger_.write_file("global_view.json", dump_json(gv, 2));
            } catch (...) {}
        }
    }
}

void SimulationEngine::add_news(std::uint64_t eid, std::string cat, std::string sev, std::string tid, std::string msg, nlohmann::json data) {
    if (graph_ && !graph_->scenario().config.news) return;
    news_.push_back({next_news_id_++, eid, virtual_s_, std::move(cat), std::move(sev), std::move(tid), std::move(msg), std::move(data)});
}

nlohmann::json SimulationEngine::clock_json() const {
    const auto duration = graph_ ? graph_->scenario().config.playback_duration_s : 60;
    const auto base = day_s / double(duration);
    return {
        {"playback_state", to_string(lifecycle_)},
        {"playback_duration_seconds", duration},
        {"simulation_percentage", virtual_s_ / double(day_s)},
        {"simulated_current_time", hhmmss(virtual_s_)},
        {"virtual_day_seconds", virtual_s_},
        {"base_rate", base},
        {"tick_rate", tick_rate_},
        {"target_virtual_rate", base * tick_rate_}
    };
}

nlohmann::json SimulationEngine::envelope(nlohmann::json data) const {
    return {
        {"ok", true},
        {"api_version", "1.0"},
        {"run_id", run_id_},
        {"global_seed", graph_ ? graph_->scenario().seed.hex() : ""},
        {"seed", graph_ ? graph_->scenario().seed.decimal() : ""},
        {"state_revision", graph_ ? graph_->state_revision() : 0},
        {"config_revision", config_revision_},
        {"clock", clock_json()},
        {"data", std::move(data)}
    };
}

nlohmann::json SimulationEngine::scheduled_events(bool future,const std::string& category,std::size_t offset,std::size_t limit) const {
    std::lock_guard lock(mutex_);return envelope(events_.inspect(future,category,offset,limit));
}

nlohmann::json SimulationEngine::status() const {
    std::lock_guard lock(mutex_);
    return envelope({
        {"lifecycle", to_string(lifecycle_)},
        {"preparation_error", preparation_error_},
        {"playback_revision", playback_revision_},
        {"run_id", run_id_},
        {"day", graph_ ? graph_->scenario().config.day : -1},
        {"calendar", graph_ ? calendar_json(graph_->scenario()) : nlohmann::json(nullptr)},
        {"saved_seed_id", graph_ ? graph_->scenario().config.saved_seed_id : ""},
        {"map_selection_version", graph_ ? graph_->scenario().config.map_selection_version : ""},
        {"traffic_model", "DSTNS aggregate traffic model"},
        {"paused", lifecycle_ == Lifecycle::Paused},
        {"simulated_seconds", virtual_s_},
        {"checkpoint_count", checkpoints_.size()},
        {"virtual_seconds_remaining", day_s - virtual_s_},
        {"modules", graph_ ? nlohmann::json{
            {"traffic", graph_->scenario().config.traffic},
            {"signals", graph_->scenario().config.signals},
            {"buildings", graph_->scenario().config.buildings},
            {"dws", graph_->scenario().config.dws},
            {"flooding", graph_->scenario().config.flooding},
            {"news", graph_->scenario().config.news}
        } : nlohmann::json::object()}
    });
}

nlohmann::json SimulationEngine::topology() const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope(nlohmann::json::object());
    nlohmann::json ns = nlohmann::json::array(), es = nlohmann::json::array();
    for (const auto& n : graph_->nodes()) {
        ns.push_back({
            {"id", n.id.value},
            {"osm_node_id", n.osm_node_id},
            {"position", point_json(n.position)},
            {"degree", n.degree},
            {"bus_stop", n.bus_stop},
            {"bus_stop_radius_m", n.bus_stop ? graph_->scenario().config.stop_max_coverage_m : 0.0},
            {"signal", n.signal},
            {"signal_cycle_s", n.signal ? n.signal_cycle_s : 0},
            {"signal_offset_s", n.signal ? n.signal_offset_s : 0},
            {"signal_green_s", n.signal ? n.signal_green_s : 0},
            {"building", n.building ? nlohmann::json(to_string(*n.building)) : nlohmann::json(nullptr)},
            {"building_impact", n.building_impact},
            {"building_radius_m", n.building_radius_m},
            {"elevation_m", n.elevation_m}
        });
    }
    for (const auto& e : graph_->edges()) {
        nlohmann::json geom = nlohmann::json::array();
        for (const auto& pt : e.geometry) {
            geom.push_back(point_json(pt));
        }
        es.push_back({
            {"id", e.id.value},
            {"from", e.from.value},
            {"to", e.to.value},
            {"reverse_twin", e.reverse_twin.value},
            {"road_class", to_string(e.road_class)},
            {"name", e.name}, {"tags", e.tags}, {"synthetic_reverse",e.synthetic_reverse},
            {"length_m", e.length_m},
            {"free_speed_mps", e.free_speed_mps},
            {"lanes", e.lanes},
            {"grade", e.grade},
            {"geometry", std::move(geom)}
        });
    }
    double min_lat = 90.0, max_lat = -90.0, min_lon = 180.0, max_lon = -180.0;
    for (const auto& n : graph_->nodes()) {
        min_lat = std::min(min_lat, n.position.lat);
        max_lat = std::max(max_lat, n.position.lat);
        min_lon = std::min(min_lon, n.position.lon);
        max_lon = std::max(max_lon, n.position.lon);
    }
    auto features=nlohmann::json::array();
    for(const auto& f:graph_->scenario().features){auto geometry=nlohmann::json::array();for(const auto& p:f.geometry)geometry.push_back(point_json(p));features.push_back({{"id",f.id},{"name",f.name},{"category",f.category},{"polygon",f.polygon},{"position",point_json(f.center)},{"geometry",geometry},{"tags",f.tags},{"anchor_node",f.anchor.value},{"demand_type",f.demand_type?nlohmann::json(to_string(*f.demand_type)):nlohmann::json(nullptr)}});}
    return envelope({
        {"features",features},
        {"map_selection_version",graph_->scenario().config.map_selection_version},
        {"source",graph_->scenario().config.osm_file.empty()?"synthetic fixture":"OpenStreetMap"},
        {"projection",{{"name","local equirectangular"},{"origin_lat",graph_->scenario().projection_lat},{"origin_lon",graph_->scenario().projection_lon},{"units","metres"}}},
        // Where on earth this graph was cut from. Positions above are true
        // metres from the projection origin; any visual compression is the
        // client's business alone.
        {"location",{
            {"city",graph_->scenario().map_city},
            {"country",graph_->scenario().map_country},
            {"anchor_lat",graph_->scenario().map_anchor_lat},
            {"anchor_lon",graph_->scenario().map_anchor_lon},
            {"city_extent_m",graph_->scenario().map_city_extent_m},
            {"downloaded",graph_->scenario().map_downloaded}}},
        {"root_node", graph_->scenario().root.value},
        {"topology_revision", 1},
        {"graph_hash", graph_->scenario().graph_hash},
        {"bounds", {{"min_lat", min_lat}, {"max_lat", max_lat}, {"min_lon", min_lon}, {"max_lon", max_lon}}},
        {"nodes", std::move(ns)},
        {"edges", std::move(es)}
    });
}

nlohmann::json SimulationEngine::snapshot() const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope(nlohmann::json::object());
    nlohmann::json ns = nlohmann::json::array(), es = nlohmann::json::array();
    for (std::size_t i = 0; i < graph_->node_states().size(); ++i) {
        const auto& s = graph_->node_states()[i];
        ns.push_back({{"id", i}, {"rainfall", s.rainfall}, {"flood", s.flood}, {"building_effect", s.building_effect}});
    }
    for (std::size_t i = 0; i < graph_->edge_states().size(); ++i) {
        const auto& s = graph_->edge_states()[i];
        es.push_back({
            {"id", i},
            {"congestion", s.congestion},
            {"rainfall", s.rainfall},
            {"flood", s.flood},
            {"effective_speed_mps", s.effective_speed_mps},
            {"vehicle_count", s.vehicle_count},
            {"halting_count", s.halting_count},
            {"closed", s.closed},
            {"incident_closed",s.incident_closed},{"manual_closed",s.manual_closed},
            {"incident_speed_multiplier",s.incident_speed_multiplier},{"signal_multiplier",s.signal_multiplier},
            {"demand_vph",s.demand_vph},{"effective_capacity_vph",s.effective_capacity_vph},
            {"mean_speed_mps",s.mean_speed_mps},
            {"demand_causes",graph_->scenario().config.buildings?events_.demand_causes(graph_->scenario(),EdgeId{static_cast<std::uint32_t>(i)}):std::vector<std::string>{}}
        });
    }

    nlohmann::json active_weather_list = nlohmann::json::array();
    const auto now_ppm = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);
    auto check_weather = [&](const DwsEvent& e) {
        if (e.epicenter.value < graph_->nodes().size()) {
            const auto storm = evaluate_storm_state(e, now_ppm, graph_->nodes()[e.epicenter.value]);
            if (storm.active) {
                active_weather_list.push_back({
                    {"id", e.id.value},
                    {"epicenter_node", e.epicenter.value},
                    {"lat", storm.cur_lat},
                    {"lon", storm.cur_lon},
                    {"x_m", storm.cur_x_m},
                    {"y_m", storm.cur_y_m},
                    {"radius_m", storm.cur_radius_m},
                    {"intensity", storm.cur_intensity},
                    {"phase", storm.phase},
                    {"flood_gain", e.flood_gain}
                });
            }
        }
    };
    if(graph_->scenario().config.dws){for (const auto& e : graph_->scenario().dws_events) check_weather(e);
    for (const auto& e : manual_weather_) check_weather(e);}

    nlohmann::json active_incidents = nlohmann::json::array();
    std::unordered_set<std::uint32_t> incident_edges;
    for (const auto& inc : graph_->scenario().incidents) {
        if (virtual_s_ >= inc.start_virtual_s && virtual_s_ < inc.end_virtual_s) {
            if (inc.edge.value < graph_->edges().size()) {
                const auto& e = graph_->edges()[inc.edge.value];
                const auto& s = graph_->edge_states()[inc.edge.value];
                incident_edges.insert(inc.edge.value);
                active_incidents.push_back({
                    {"incident_id", inc.id},
                    {"type", to_string(inc.type)},
                    {"description", inc.description},
                    {"edge_id", e.id.value},
                    {"from_node", e.from.value},
                    {"to_node", e.to.value},
                    {"node_id", inc.node.value},
                    {"road_class", to_string(e.road_class)},
                    {"congestion", s.congestion},
                    {"flood", s.flood},
                    {"closed", s.closed},
                    {"effective_speed_mps", s.effective_speed_mps},
                    {"vehicle_count", s.vehicle_count},
                    {"speed_multiplier", inc.speed_multiplier},
                    {"capacity_multiplier", inc.capacity_multiplier},
                    {"start_virtual_s", inc.start_virtual_s},
                    {"end_virtual_s", inc.end_virtual_s},
                    {"remaining_s", inc.end_virtual_s > virtual_s_ ? (inc.end_virtual_s - virtual_s_) : 0}
                });
            }
        }
    }
    nlohmann::json event_stack = nlohmann::json::array();
    const std::size_t stack_count = std::min<std::size_t>(news_.size(), 25);
    for (std::size_t i = news_.size() - stack_count; i < news_.size(); ++i) {
        const auto& n = news_[i];
        event_stack.push_back({
            {"news_id", n.news_id},
            {"event_id", n.event_id},
            {"simulated_current_time", hhmmss(n.virtual_s)},
            {"virtual_s", n.virtual_s},
            {"category", n.category},
            {"severity", n.severity},
            {"template_id", n.template_id},
            {"message", n.message},
            {"data", n.data}
        });
    }

    nlohmann::json active_surges_list = nlohmann::json::array();
    for (const auto& s : active_surges_) {
        if (virtual_s_ >= s.start_s && virtual_s_ <= s.end_s && s.node.value < graph_->nodes().size() && s.end_s > s.start_s) {
            const auto& n = graph_->nodes()[s.node.value];
            const double rel_t = double(virtual_s_ - s.start_s) / double(s.end_s - s.start_s);
            const double bell = std::sin(3.141592653589793 * rel_t);
            const double bell_weight = bell * bell;
            const double cur_factor = 1.0 + (s.factor - 1.0) * bell_weight;
            const double cur_radius = s.radius_m * (0.35 + 0.65 * bell_weight);

            active_surges_list.push_back({
                {"id", s.id},
                {"node_id", s.node.value},
                {"lat", n.position.lat},
                {"lon", n.position.lon},
                {"x_m", n.position.x_m},
                {"y_m", n.position.y_m},
                {"radius_m", cur_radius},
                {"factor", cur_factor},
                {"start_s", s.start_s},
                {"end_s", s.end_s},
                {"remaining_s", s.end_s - virtual_s_},
                {"label", s.label}
            });
        }
    }

    auto congestion=congestion_.json();congestion.erase("history");
    return envelope({
        {"signals",signal_state_json()},
        {"demand",events_.demand_json(graph_->scenario())},
        {"congestion",congestion},
        {"topology_revision", 1},
        {"nodes", std::move(ns)},
        {"edges", std::move(es)},
        {"active_weather_events", active_weather_list.size()},
        {"active_weather", std::move(active_weather_list)},
        {"active_surges", std::move(active_surges_list)},
        {"active_incidents", std::move(active_incidents)},
        {"event_stack", std::move(event_stack)}
    });
}

nlohmann::json SimulationEngine::nodes(std::size_t off, std::size_t lim) const {
    std::lock_guard lock(mutex_);
    nlohmann::json items = nlohmann::json::array();
    if (graph_) {
        for (std::size_t i = off; i < std::min(graph_->nodes().size(), off + lim); ++i) {
            const auto& n = graph_->nodes()[i];
            const auto& s = graph_->node_states()[i];
            items.push_back({
                {"id", n.id.value},
                {"osm_node_id", n.osm_node_id},
                {"position", point_json(n.position)},
                {"degree", n.degree},
                {"roles", {{"bus_stop", n.bus_stop}, {"signal", n.signal}, {"building", n.building.has_value()}}},
                {"building", n.building ? nlohmann::json{
                    {"type", to_string(*n.building)},
                    {"impact", n.building_impact},
                    {"radius_m", n.building_radius_m},
                    {"current_effect", s.building_effect}
                } : nlohmann::json(nullptr)},
                {"weather", {
                    {"rainfall", s.rainfall},
                    {"flood", s.flood},
                    {"flood_susceptibility", n.flood_susceptibility},
                    {"drainage", n.drainage}
                }}
            });
        }
    }
    return envelope({{"offset", off}, {"limit", lim}, {"total", graph_ ? graph_->nodes().size() : 0}, {"items", std::move(items)}});
}

nlohmann::json SimulationEngine::edges(std::size_t off, std::size_t lim) const {
    std::lock_guard lock(mutex_);
    nlohmann::json items = nlohmann::json::array();
    if (graph_) {
        for (std::size_t i = off; i < std::min(graph_->edges().size(), off + lim); ++i) {
            const auto& e = graph_->edges()[i];
            const auto& s = graph_->edge_states()[i];
            items.push_back({
                {"id", e.id.value},
                {"from", e.from.value},
                {"to", e.to.value},
                {"reverse_twin", e.reverse_twin.value},
                {"source", {{"osm_way_id", e.osm_way_id}, {"synthetic_reverse", e.synthetic_reverse}}},
                {"road", {
                    {"class", to_string(e.road_class)},
                    {"lanes", e.lanes},
                    {"length_m", e.length_m},
                    {"free_speed_mps", e.free_speed_mps},
                    {"base_capacity_vph", e.base_capacity_vph}
                }},
                {"traffic", {
                    {"demand_vph", s.demand_vph},
                    {"effective_capacity_vph", s.effective_capacity_vph},
                    {"effective_speed_mps", s.effective_speed_mps},
                    {"vehicle_count", s.vehicle_count},
                    {"halting_count", s.halting_count},
                    {"mean_speed_mps", s.mean_speed_mps},
                    {"occupancy", s.occupancy},
                    {"congestion", s.congestion}
                }},
                {"weather", {{"rainfall", s.rainfall}, {"flood", s.flood}}},
                {"control", {
                    {"closed", s.closed},
                    {"manual_speed_multiplier", s.manual_speed_multiplier},
                    {"manual_capacity_multiplier", s.manual_capacity_multiplier}
                }}
            });
        }
    }
    return envelope({{"offset", off}, {"limit", lim}, {"total", graph_ ? graph_->edges().size() : 0}, {"items", std::move(items)}});
}

nlohmann::json SimulationEngine::manifest() const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope(nlohmann::json::object());
    const auto& s = graph_->scenario();
    return envelope({
        {"product", "DSTNS"},
        {"version", "1.0.0"},
        {"algorithm_version", "DSTNS/1"},
        {"determinism_level", 2},
        {"seed", s.seed.decimal()},
        {"seed_hex", s.seed.hex()},
        {"map_hash", s.map_hash},
        {"graph_hash", s.graph_hash},
        {"event_hash", s.event_hash},
        {"scenario_hash", s.scenario_hash},
        {"map_source", s.config.osm_file.empty() ? "offline-deterministic-road-fixture" : "osm-xml"},
        {"calendar", calendar_json(s)},
        {"terrain", s.terrain ? terrain_json(*s.terrain) : nlohmann::json(nullptr)},
        {"road_filter_version", "road-only/v1"}
    });
}

nlohmann::json SimulationEngine::places(const std::string& kind,std::size_t offset,std::size_t limit) const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope({{"items",nlohmann::json::array()},{"total",0},{"offset",offset},{"limit",limit}});
    const auto& sc = graph_->scenario();
    const auto& kinds = events_.place_kinds();

    // Select first, then page, so `total` counts the filter's matches and not
    // the whole world - a caller paging schools should not have to walk every
    // untagged building to find them.
    std::vector<std::size_t> selected;
    for (std::size_t i = 0; i < sc.features.size(); ++i) {
        const auto k = i < kinds.size() ? kinds[i] : PlaceKind::Other;
        if (!kind.empty() && kind != to_string(k)) continue;
        selected.push_back(i);
    }

    auto items = nlohmann::json::array();
    for (std::size_t n = offset; n < selected.size() && n < offset + limit; ++n) {
        const auto i = selected[n];
        const auto& f = sc.features[i];
        const auto k = i < kinds.size() ? kinds[i] : PlaceKind::Other;
        auto factors = nlohmann::json::array();
        for (const auto& factor : events_.demand_factors(i))
            factors.push_back({{"cause",factor.name},{"multiplier",factor.multiplier}});
        items.push_back({
            {"id",f.id},
            {"name",f.name},
            {"kind",to_string(k)},
            {"category",f.category},
            {"modelled",is_modelled(k)},
            {"generator",is_generator(k)},
            {"commercial",is_commercial(k)},
            {"polygon",f.polygon},
            {"position",point_json(f.center)},
            {"anchor_node",f.anchor.value},
            {"tags",f.tags},
            {"demand",{
                {"multiplier",sc.config.buildings && i < events_.demand.size() ? events_.demand[i] : 1.0},
                {"baseline",sc.config.buildings ? events_.baseline_demand(i) : 1.0},
                {"factors",std::move(factors)},
                {"radius_m",kCouplingRadiusM}}}
        });
    }
    return envelope({{"items",std::move(items)},
                     {"total",selected.size()},
                     {"offset",offset},
                     {"limit",limit},
                     {"kind",kind.empty()?"all":kind}});
}

nlohmann::json SimulationEngine::place_kinds() const {
    std::lock_guard lock(mutex_);
    // Counts come from this world; the taxonomy itself does not, so a caller
    // learns every kind the classifier can produce even when none are present.
    std::map<std::string,std::size_t> counts;
    if (graph_) for (const auto k : events_.place_kinds()) counts[to_string(k)]++;

    auto items = nlohmann::json::array();
    for (const auto k : {PlaceKind::School,PlaceKind::University,PlaceKind::Office,PlaceKind::Retail,
                         PlaceKind::Mall,PlaceKind::Hospital,PlaceKind::Pharmacy,PlaceKind::Food,
                         PlaceKind::Transport,PlaceKind::BusStop,PlaceKind::Parking,PlaceKind::Park,
                         PlaceKind::Industrial,PlaceKind::Residential,PlaceKind::Worship,
                         PlaceKind::Culture,PlaceKind::Hotel,PlaceKind::Other}) {
        const std::string name = to_string(k);
        items.push_back({{"kind",name},
                         {"modelled",is_modelled(k)},
                         {"generator",is_generator(k)},
                         {"commercial",is_commercial(k)},
                         {"count",counts.count(name)?counts.at(name):0}});
    }
    return envelope({{"items",std::move(items)},{"stop_spacing_m",kBusStopSpacingM}});
}

nlohmann::json SimulationEngine::catalog(const std::string& kind) const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope(nlohmann::json::object());
    const auto& sc = graph_->scenario();
    nlohmann::json items = nlohmann::json::array();
    if (kind == "bus-stops") {
        for (const auto& x : sc.bus_stops) {
            items.push_back({
                {"id", x.id.value},
                {"anchor_node", x.anchor_node.value},
                {"edge", x.edge.value},
                {"position_m", x.position_m},
                {"nearest_stop_distance_m", x.nearest_stop_distance_m}
            });
        }
    } else if (kind == "buildings") {
        for (const auto& n : sc.nodes) {
            if (n.building) {
                items.push_back({
                    {"node_id", n.id.value},
                    {"type", to_string(*n.building)},
                    {"impact", n.building_impact},
                    {"radius_m", n.building_radius_m},
                    {"current_effect", graph_->node_states()[n.id.value].building_effect}
                });
            }
        }
    } else if (kind == "congestion") {
        return envelope(congestion_.json());
    } else if (kind == "signals") {
        return envelope({{"items",signal_state_json()}});
    } else if (kind == "legacy-signal-plans") {
        for (const auto& x : sc.signals) {
            items.push_back({
                {"node_id", x.node.value},
                {"cycle_s", x.cycle_s},
                {"phases_s", x.phases_s}
            });
        }
    } else if (kind == "weather" || kind == "events") {
        const auto now = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);
        for (const auto& x : sc.dws_events) {
            items.push_back({
                {"event_id", x.id.value},
                {"epicenter_node", x.epicenter.value},
                {"start_ppm", x.start_ppm},
                {"end_ppm", x.end_ppm},
                {"intensity", x.intensity},
                {"radius_m", x.radius_m},
                {"active", now >= x.start_ppm && now < x.end_ppm},
                {"source", "base"}
            });
        }
        for (const auto& x : manual_weather_) {
            items.push_back({
                {"event_id", x.id.value},
                {"epicenter_node", x.epicenter.value},
                {"start_ppm", x.start_ppm},
                {"end_ppm", x.end_ppm},
                {"intensity", x.intensity},
                {"radius_m", x.radius_m},
                {"active", now >= x.start_ppm && now < x.end_ppm},
                {"source", "manual"}
            });
        }
    } else if (kind == "traffic" || kind == "metrics") {
        double weighted = 0, length = 0, speed_sum = 0;
        std::uint64_t vehicles = 0, halting = 0, flooded = 0, closed = 0;
        std::size_t counted = 0;
        std::vector<double> congestion;
        for (std::size_t i = 0; i < sc.edges.size(); ++i) {
            const auto& e = sc.edges[i];
            const auto& s = graph_->edge_states()[i];
            if(!is_source_direction_allowed(e))continue;
            weighted += e.length_m * s.congestion;
            length += e.length_m;
            speed_sum += s.mean_speed_mps;
            ++counted;
            vehicles += s.vehicle_count;
            halting += s.halting_count;
            flooded += s.flood > .01;
            closed += s.closed;
            congestion.push_back(s.congestion);
        }
        std::sort(congestion.begin(), congestion.end());
        const auto p95 = congestion.empty() ? 0 : congestion[std::min(congestion.size() - 1, static_cast<std::size_t>(congestion.size() * .95))];
        return envelope({
            {"network_congestion_length_weighted", weighted / std::max(1.0, length)},
            {"network_congestion_p95", p95},
            {"flooded_edge_count", flooded},
            {"closed_edge_count", closed},
            {"mean_vehicle_speed_mps", speed_sum / std::max<std::size_t>(1, counted)},
            {"vehicle_count", vehicles},
            {"halting_vehicle_count", halting},
            {"active_dws_events", std::count_if(sc.dws_events.begin(), sc.dws_events.end(), [&](const auto& e) {
                auto now = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);
                return now >= e.start_ppm && now < e.end_ppm;
            })},
            {"hotspot_edge_count", sc.hotspot_edges.size()}
        });
    } else if (kind == "incidents") {
        for (const auto& inc : sc.incidents) {
            items.push_back({
                {"incident_id", inc.id},
                {"type", to_string(inc.type)},
                {"description", inc.description},
                {"edge_id", inc.edge.value},
                {"node_id", inc.node.value},
                {"start_virtual_s", inc.start_virtual_s},
                {"end_virtual_s", inc.end_virtual_s},
                {"speed_multiplier", inc.speed_multiplier},
                {"capacity_multiplier", inc.capacity_multiplier},
                {"closed", inc.closed},
                {"active", virtual_s_ >= inc.start_virtual_s && virtual_s_ < inc.end_virtual_s}
            });
        }
    } else {
        throw std::invalid_argument("unknown view catalog: " + kind);
    }
    return envelope({{"items", std::move(items)}});
}

nlohmann::json SimulationEngine::environment() const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope(nlohmann::json::object());
    const auto& sc = graph_->scenario();
    nlohmann::json fields = nlohmann::json::array();
    if (sc.terrain) fields.push_back({{"name", "elevation"}, {"units", "m"}, {"kind", "static"}});
    double max_grade = 0;
    for (const auto& e : sc.edges)
        if (is_source_direction_allowed(e)) max_grade = std::max(max_grade, std::abs(e.grade));
    return envelope({
        {"schema_version", 1},
        {"calendar", calendar_json(sc)},
        {"terrain", sc.terrain ? terrain_json(*sc.terrain) : nlohmann::json(nullptr)},
        {"roads", {{"max_abs_grade", max_grade}}},
        {"fields", std::move(fields)}
    });
}

nlohmann::json SimulationEngine::field(const std::string& name, std::uint32_t max_side) const {
    std::lock_guard lock(mutex_);
    if (!graph_) throw std::logic_error("no active simulation");
    const auto& sc = graph_->scenario();
    const auto raster = [&](const env::GridSpec& grid, const auto* values, const char* units, double precision) {
        const auto [g, reduced] = env::downsample_mean(grid, values, std::clamp<std::uint32_t>(max_side, 8, 512));
        auto out = nlohmann::json::array();
        double lo = std::numeric_limits<double>::max(), hi = -lo;
        for (const auto v : reduced) {
            out.push_back(std::round(v / precision) * precision);
            lo = std::min(lo, double(v));
            hi = std::max(hi, double(v));
        }
        return envelope({{"name", name}, {"units", units}, {"width", g.width}, {"height", g.height},
                         {"origin_x_m", g.origin_x_m}, {"origin_y_m", g.origin_y_m}, {"cell_m", g.cell_m},
                         {"solver_cell_m", grid.cell_m}, {"min", lo}, {"max", hi},
                         {"layout", "row-major, south row first; cell (0,0) is the south-west corner"},
                         {"values", std::move(out)}});
    };
    if (name == "elevation" && sc.terrain) return raster(sc.terrain->grid, sc.terrain->elevation_m.data(), "m", 0.1);
    if (name == "slope" && sc.terrain) return raster(sc.terrain->grid, sc.terrain->slope.data(), "m/m", 0.001);
    throw std::invalid_argument("unknown field: " + name);
}

nlohmann::json SimulationEngine::news(std::uint64_t since, std::size_t limit) const {
    std::lock_guard lock(mutex_);
    nlohmann::json items = nlohmann::json::array();
    for (const auto& n : news_) {
        if (n.news_id > since && items.size() < limit) {
            items.push_back({
                {"news_id", n.news_id},
                {"event_id", n.event_id},
                {"virtual_day_s", n.virtual_s},
                {"simulated_current_time", hhmmss(n.virtual_s)},
                {"category", n.category},
                {"severity", n.severity},
                {"template_id", n.template_id},
                {"message", n.message},
                {"data", n.data}
            });
        }
    }
    return envelope({{"items", std::move(items)}});
}

nlohmann::json SimulationEngine::history() const {
    std::lock_guard lock(mutex_);
    nlohmann::json a = nlohmann::json::array();
    for (const auto& c : commands_) {
        a.push_back({
            {"command_id", c.id},
            {"type", c.type},
            {"status", c.status},
            {"virtual_day_s", c.virtual_s},
            {"undoable", true}
        });
    }
    for (const auto& c : redo_) {
        a.push_back({
            {"command_id", c.id},
            {"type", c.type},
            {"status", "undone"},
            {"virtual_day_s", c.virtual_s},
            {"undoable", true}
        });
    }
    return envelope({{"commands", std::move(a)}, {"undo_depth", commands_.size()}, {"redo_depth", redo_.size()}});
}

nlohmann::json SimulationEngine::compute_status() const {
    std::lock_guard lock(mutex_);
    return compute_->describe();
}

void SimulationEngine::initialize_compute() {
    std::lock_guard lock(mutex_);
    compute_->initialize();
}

bool SimulationEngine::select_compute_backend(compute::BackendType type) {
    std::lock_guard lock(mutex_);
    if (!graph_) return false;
    try {
        return compute_->select(type, "selected by the operator");
    } catch (const compute::StateLost& lost) {
        logger_.system("ERROR", "compute", std::string("compute.device_lost ") + lost.what());
        recover_compute(virtual_s_);
        return type == compute::BackendType::Cpu;
    }
}

std::uint64_t SimulationEngine::state_revision() const {
    std::lock_guard lock(mutex_);
    return graph_ ? graph_->state_revision() : 0;
}

Lifecycle SimulationEngine::lifecycle() const {
    // Deliberately lock-free: liveness must be observable while the engine is
    // busy compiling a world. See transition().
    return lifecycle_mirror_.load(std::memory_order_relaxed);
}

nlohmann::json SimulationEngine::global_view() const {
    std::lock_guard lock(mutex_);
    if (!graph_) return envelope(nlohmann::json::object());

    const auto& sc = graph_->scenario();

    double min_lat = 90.0, max_lat = -90.0, min_lon = 180.0, max_lon = -180.0;
    for (const auto& n : graph_->nodes()) {
        min_lat = std::min(min_lat, n.position.lat);
        max_lat = std::max(max_lat, n.position.lat);
        min_lon = std::min(min_lon, n.position.lon);
        max_lon = std::max(max_lon, n.position.lon);
    }
    const double center_lat = (min_lat + max_lat) / 2.0;
    const double center_lon = (min_lon + max_lon) / 2.0;

    nlohmann::json nodes_json = nlohmann::json::array();
    for (std::size_t i = 0; i < graph_->nodes().size(); ++i) {
        const auto& n = graph_->nodes()[i];
        const auto& ns = graph_->node_states()[i];
        nlohmann::json time_windows = nlohmann::json::array();
        for (const auto& tw : n.tmax) {
            time_windows.push_back({
                {"start_ppm", tw.start_ppm},
                {"end_ppm", tw.end_ppm},
                {"rise_power", tw.rise_power},
                {"fall_power", tw.fall_power}
            });
        }
        nodes_json.push_back({
            {"id", n.id.value},
            {"osm_node_id", n.osm_node_id},
            {"position", point_json(n.position)},
            {"degree", n.degree},
            {"flood_susceptibility", n.flood_susceptibility},
            {"drainage", n.drainage},
            {"roles", {
                {"bus_stop", n.bus_stop},
                {"signal", n.signal},
                {"building", n.building.has_value()}
            }},
            {"building", n.building ? nlohmann::json{
                {"type", to_string(*n.building)},
                {"impact", n.building_impact},
                {"radius_m", n.building_radius_m},
                {"current_effect", ns.building_effect}
            } : nlohmann::json(nullptr)},
            {"time_windows", std::move(time_windows)},
            {"dynamic", {
                {"rainfall", ns.rainfall},
                {"flood", ns.flood},
                {"building_effect", ns.building_effect},
                {"state_revision", ns.state_revision}
            }}
        });
    }

    nlohmann::json edges_json = nlohmann::json::array();
    std::uint64_t total_vehicles = 0;
    double sum_speed_mps = 0;
    std::size_t flooded_edges = 0;
    std::size_t closed_edges = 0;

    for (std::size_t i = 0; i < graph_->edges().size(); ++i) {
        const auto& e = graph_->edges()[i];
        const auto& es = graph_->edge_states()[i];

        total_vehicles += es.vehicle_count;
        sum_speed_mps += es.effective_speed_mps;
        if (es.flood >= 0.50) flooded_edges++;
        if (es.closed) closed_edges++;

        edges_json.push_back({
            {"id", e.id.value},
            {"from", e.from.value},
            {"to", e.to.value},
            {"reverse_twin", e.reverse_twin.value},
            {"osm_way_id", e.osm_way_id},
            {"segment_index", e.segment_index},
            {"road_class", to_string(e.road_class)},
            {"lanes", e.lanes},
            {"source_oneway", e.source_oneway},
            {"synthetic_reverse", e.synthetic_reverse},
            {"length_m", e.length_m},
            {"free_speed_mps", e.free_speed_mps},
            {"free_speed_kmh", e.free_speed_mps * 3.6},
            {"base_capacity_vph", e.base_capacity_vph},
            {"hotspot_susceptibility", e.hotspot_susceptibility},
            {"flood_susceptibility", e.flood_susceptibility},
            {"geometry", [&]() {
                nlohmann::json g = nlohmann::json::array();
                for (const auto& pt : e.geometry) g.push_back(point_json(pt));
                return g;
            }()},
            {"dynamic", {
                {"demand_vph", es.demand_vph},
                {"effective_capacity_vph", es.effective_capacity_vph},
                {"effective_speed_mps", es.effective_speed_mps},
                {"effective_speed_kmh", es.effective_speed_mps * 3.6},
                {"mean_speed_mps", es.mean_speed_mps},
                {"mean_speed_kmh", es.mean_speed_mps * 3.6},
                {"vehicle_count", es.vehicle_count},
                {"halting_count", es.halting_count},
                {"occupancy", es.occupancy},
                {"congestion", es.congestion},
                {"congestion_model", es.congestion_model},
                {"congestion_observed", es.congestion_observed},
                {"rainfall", es.rainfall},
                {"flood", es.flood},
                {"closed", es.closed},
                {"manual_closed", es.manual_closed},
                {"signal_multiplier", es.signal_multiplier},
                {"rain_speed_multiplier", es.rain_speed_multiplier},
                {"flood_speed_multiplier", es.flood_speed_multiplier},
                {"rain_capacity_multiplier", es.rain_capacity_multiplier},
                {"flood_capacity_multiplier", es.flood_capacity_multiplier},
                {"manual_speed_multiplier", es.manual_speed_multiplier},
                {"manual_capacity_multiplier", es.manual_capacity_multiplier},
                {"state_revision", es.state_revision}
            }}
        });
    }

    const double edge_count_d = std::max<double>(1.0, graph_->edges().size());
    const double mean_speed_mps = sum_speed_mps / edge_count_d;


    nlohmann::json active_weather_list = nlohmann::json::array();
    nlohmann::json scheduled_weather_list = nlohmann::json::array();
    const auto now_ppm = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);

    auto inspect_event = [&](const DwsEvent& ev) {
        if (ev.epicenter.value >= graph_->nodes().size()) return;
        const auto start_s = std::uint32_t(std::uint64_t(ev.start_ppm) * day_s / ppm);
        const auto end_s = std::uint32_t(std::uint64_t(ev.end_ppm) * day_s / ppm);
        const auto& epic_node = graph_->nodes()[ev.epicenter.value];
        const auto storm = evaluate_storm_state(ev, now_ppm, epic_node);
        const bool active = storm.active;

        if (storm.active) {
            active_weather_list.push_back({
                {"id", ev.id.value},
                {"epicenter_node", ev.epicenter.value},
                {"lat", storm.cur_lat},
                {"lon", storm.cur_lon},
                {"x_m", storm.cur_x_m},
                {"y_m", storm.cur_y_m},
                {"radius_m", storm.cur_radius_m},
                {"intensity", storm.cur_intensity},
                {"phase", storm.phase},
                {"flood_gain", ev.flood_gain}
            });
        }

        scheduled_weather_list.push_back({
            {"id", ev.id.value},
            {"epicenter_node", ev.epicenter.value},
            {"lat", epic_node.position.lat},
            {"lon", epic_node.position.lon},
            {"start_time", hhmmss(start_s)},
            {"end_time", hhmmss(end_s)},
            {"start_ppm", ev.start_ppm},
            {"end_ppm", ev.end_ppm},
            {"radius_m", ev.radius_m},
            {"intensity", ev.intensity},
            {"flood_gain", ev.flood_gain},
            {"status", active ? "active" : virtual_s_ >= end_s ? "passed" : "pending"}
        });
    };

    for (const auto& ev : sc.dws_events) inspect_event(ev);
    for (const auto& ev : manual_weather_) inspect_event(ev);

    nlohmann::json signals_list = nlohmann::json::array();
    for (const auto& sig : sc.signals) {
        signals_list.push_back({
            {"node_id", sig.node.value},
            {"cycle_s", sig.cycle_s},
            {"phases_s", sig.phases_s}
        });
    }

    nlohmann::json bus_stops_list = nlohmann::json::array();
    for (const auto& bs : sc.bus_stops) {
        bus_stops_list.push_back({
            {"id", bs.id.value},
            {"anchor_node", bs.anchor_node.value},
            {"edge_id", bs.edge.value},
            {"position_m", bs.position_m},
            {"nearest_stop_distance_m", bs.nearest_stop_distance_m}
        });
    }

    nlohmann::json buildings_list = nlohmann::json::array();
    for (const auto& n : sc.nodes) {
        if (n.building) {
            buildings_list.push_back({
                {"node_id", n.id.value},
                {"type", to_string(*n.building)},
                {"impact", n.building_impact},
                {"radius_m", n.building_radius_m}
            });
        }
    }

    nlohmann::json active_incidents = nlohmann::json::array();
    std::unordered_set<std::uint32_t> gv_incident_edges;
    for (const auto& inc : sc.incidents) {
        if (virtual_s_ >= inc.start_virtual_s && virtual_s_ < inc.end_virtual_s) {
            if (inc.edge.value < graph_->edges().size()) {
                const auto& e = graph_->edges()[inc.edge.value];
                const auto& s = graph_->edge_states()[inc.edge.value];
                gv_incident_edges.insert(inc.edge.value);
                active_incidents.push_back({
                    {"incident_id", inc.id},
                    {"type", to_string(inc.type)},
                    {"description", inc.description},
                    {"edge_id", e.id.value},
                    {"from_node", e.from.value},
                    {"to_node", e.to.value},
                    {"node_id", inc.node.value},
                    {"road_class", to_string(e.road_class)},
                    {"congestion", s.congestion},
                    {"flood", s.flood},
                    {"closed", s.closed},
                    {"effective_speed_mps", s.effective_speed_mps},
                    {"effective_speed_kmh", s.effective_speed_mps * 3.6},
                    {"vehicle_count", s.vehicle_count},
                    {"speed_multiplier", inc.speed_multiplier},
                    {"capacity_multiplier", inc.capacity_multiplier},
                    {"start_virtual_s", inc.start_virtual_s},
                    {"end_virtual_s", inc.end_virtual_s},
                    {"remaining_s", inc.end_virtual_s > virtual_s_ ? (inc.end_virtual_s - virtual_s_) : 0}
                });
            }
        }
    }
    nlohmann::json recent_events = nlohmann::json::array();
    const std::size_t count = std::min<std::size_t>(news_.size(), 50);
    for (std::size_t i = news_.size() - count; i < news_.size(); ++i) {
        const auto& n = news_[i];
        recent_events.push_back({
            {"news_id", n.news_id},
            {"event_id", n.event_id},
            {"simulated_current_time", hhmmss(n.virtual_s)},
            {"virtual_day_seconds", n.virtual_s},
            {"category", n.category},
            {"severity", n.severity},
            {"template_id", n.template_id},
            {"message", n.message},
            {"data", n.data}
        });
    }

    return envelope({
        {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
        {"version", DSTNS_VERSION},
        {"lifecycle", to_string(lifecycle_)},
        {"playback_revision", playback_revision_},
        {"run_id", run_id_},
        {"global_seed", sc.seed.hex()},
        {"seed", sc.seed.decimal()},
        {"state_revision", graph_->state_revision()},
        {"config_revision", config_revision_},
        {"bounds", {
            {"min_lat", min_lat}, {"max_lat", max_lat},
            {"min_lon", min_lon}, {"max_lon", max_lon},
            {"center_lat", center_lat}, {"center_lon", center_lon}
        }},
        {"metrics", {
            {"total_nodes", graph_->nodes().size()},
            {"total_edges", graph_->edges().size()},
            {"total_vehicles", total_vehicles},
            {"mean_network_speed_mps", mean_speed_mps},
            {"mean_network_speed_kmh", mean_speed_mps * 3.6},
            {"mean_network_congestion", congestion_.current/100.0},
            {"average_network_congestion",congestion_.average/100.0},
            {"active_weather_count", active_weather_list.size()},
            {"flooded_edges_count", flooded_edges},
            {"closed_edges_count", closed_edges}
        }},
        {"modules", {
            {"traffic", sc.config.traffic},
            {"signals", sc.config.signals},
            {"buildings", sc.config.buildings},
            {"dws", sc.config.dws},
            {"flooding", sc.config.flooding},
            {"news", sc.config.news}
        }},
        {"calendar", calendar_json(sc)},
        {"manifest", {
            {"map_hash", sc.map_hash},
            {"graph_hash", sc.graph_hash},
            {"event_hash", sc.event_hash},
            {"scenario_hash", sc.scenario_hash}
        }},
        {"nodes", std::move(nodes_json)},
        {"edges", std::move(edges_json)},
        {"weather", {
            {"active_count", active_weather_list.size()},
            {"active_events", std::move(active_weather_list)},
            {"scheduled_events", std::move(scheduled_weather_list)}
        }},
        {"signals", std::move(signals_list)},
        {"bus_stops", std::move(bus_stops_list)},
        {"buildings", std::move(buildings_list)},
        {"active_incidents", std::move(active_incidents)},
        {"recent_events", std::move(recent_events)}
    });
}

nlohmann::json SimulationEngine::export_sumo(const std::filesystem::path& directory) const {
    std::lock_guard lock(mutex_);
    if (!graph_) throw std::logic_error("no active simulation");
    SumoBridge::export_bundle(graph_->scenario(), directory);
    return envelope({
        {"ok", true},
        {"message", "SUMO scenario bundle exported"},
        {"directory", directory.string()},
        {"files", {
            "network.nod.xml",
            "network.edg.xml",
            "sandbox.rou.xml",
            "sandbox.add.xml",
            "sandbox.sumocfg"
        }}
    });
}

nlohmann::json SimulationEngine::sumo_simulate(const std::filesystem::path& directory, std::uint32_t begin_s, std::uint32_t end_s) const {
    if (end_s <= begin_s || end_s > day_s) throw std::invalid_argument("SUMO period must satisfy begin_s < end_s <= 86400");
    // SUMO runs for as long as it takes; hold a copy of the scenario rather
    // than the engine lock, so playback and the API carry on meanwhile.
    std::optional<Scenario> scenario;
    {
        std::lock_guard lock(mutex_);
        if (!graph_) throw std::logic_error("no active simulation");
        scenario.emplace(graph_->scenario());
    }
    auto res = SumoBridge::simulate(*scenario, directory, begin_s, end_s);
    std::lock_guard lock(mutex_);
    return envelope(std::move(res));
}

void SimulationEngine::request_terminate() {
    // Deliberately lock-free: a compile may hold the mutex for the length of a
    // map download, and quitting must not queue behind it.
    if (terminate_requested_.exchange(true)) return;
    cancel_map_download();
    // compile_generation_ is guarded by the mutex, so it is deliberately not
    // touched here. The flag and the stop request are enough to wind the worker
    // down; the HTTP layer guarantees the process exits regardless.
    cv_.notify_all();
    worker_.request_stop();
}

void SimulationEngine::terminate() {
    std::lock_guard lock(mutex_);
    if (terminate_requested_.exchange(true)) return;
    ++compile_generation_;
    transition(Lifecycle::Terminating);
    cv_.notify_all();
    worker_.request_stop();
}

} // namespace dstns
