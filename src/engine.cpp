#include "dstns/engine.hpp"
#include "dstns/sumo_bridge.hpp"

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <numeric>
#include <sstream>
#include <stdexcept>

namespace dstns {
namespace {
constexpr std::uint32_t day_s = 86400, ppm = 1'000'000;
std::string hhmmss(std::uint32_t s) {
    s %= day_s;
    std::ostringstream o;
    o << std::setfill('0') << std::setw(2) << s / 3600 << ':' << std::setw(2) << (s % 3600) / 60 << ':' << std::setw(2) << s % 60;
    return o.str();
}
double clamp01(double x) { return std::clamp(x, 0.0, 1.0); }
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

SimulationEngine::SimulationEngine(RuntimeLogger& logger)
    : logger_(logger) {
    try {
        ScenarioConfig cfg{};
        if (std::filesystem::exists("data/fixtures/downtown_osm.xml")) {
            cfg.osm_file = "data/fixtures/downtown_osm.xml";
        }
        auto seed = Seed128::parse("0x508905019bc2221d083c848bf3e12e22");
        auto scenario = compiler_.compile(seed, cfg);
        run_id_ = "run_" + scenario.scenario_hash.substr(7, 12);
        graph_ = std::make_unique<GraphStore>(std::move(scenario));
        tick_rate_ = 1.0;
        virtual_s_ = 0;
        anchor_wall_clock();
    } catch (const std::exception& e) {
        logger_.system("ERROR", "engine", std::string("Init default scenario failed: ") + e.what());
    }
    worker_ = std::jthread([this](std::stop_token) { loop(); });
    logger_.system("INFO", "engine", "DSTNS engine idle");
}

SimulationEngine::~SimulationEngine() {
    terminate();
}

void SimulationEngine::transition(Lifecycle next) {
    const auto old = lifecycle_;
    lifecycle_ = next;
    logger_.lifecycle(run_id_, to_string(old), to_string(next), graph_ ? graph_->state_revision() : 0);
}

void SimulationEngine::anchor_wall_clock() {
    anchor_wall_ = std::chrono::steady_clock::now();
    anchor_virtual_s_ = virtual_s_;
}

nlohmann::json SimulationEngine::start(Seed128 seed, const ScenarioConfig& config, std::uint32_t start) {
    std::lock_guard lock(mutex_);
    if (lifecycle_ == Lifecycle::Running || lifecycle_ == Lifecycle::Paused || lifecycle_ == Lifecycle::Preparing) {
        throw std::logic_error("a simulation is already active");
    }
    transition(Lifecycle::Preparing);
    try {
        auto scenario = compiler_.compile(seed, config);
        run_id_ = "run_" + scenario.scenario_hash.substr(7, 12);
        graph_ = std::make_unique<GraphStore>(std::move(scenario));
        tick_rate_ = config.tick_rate;
        virtual_s_ = 0;
        start_virtual_s_ = std::min(start, day_s);
        manual_weather_.clear();
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
        add_news(4, "traffic", "info", "PHYSICS_ENGINE_ACTIVE",
                 "[" + hhmmss(virtual_s_) + "] Microscopic physics engine active with deterministic queue dynamics.");
        checkpoints_.push_back({0, graph_->node_states(), graph_->edge_states(), news_.size()});
        if (start_virtual_s_) restore_to(start_virtual_s_);
        transition(Lifecycle::Running);
        anchor_wall_clock();
        cv_.notify_all();
        return {
            {"ok", true},
            {"message", "Simulation accepted and prepared."},
            {"run_id", run_id_},
            {"seed", graph_->scenario().seed.hex()},
            {"lifecycle", to_string(lifecycle_)},
            {"resolved_config", {
                {"playback_duration_seconds", config.playback_duration_s},
                {"tick_rate", tick_rate_},
                {"day", graph_->scenario().config.day}
            }},
            {"stream", {
                {"snapshot", "/api/v1/view/snapshot"},
                {"bulk_stream", "/api/v1/view/stream"},
                {"news_stream", "/api/v1/news/stream"}
            }}
        };
    } catch (...) {
        transition(Lifecycle::Idle);
        throw;
    }
}

nlohmann::json SimulationEngine::pause() {
    std::lock_guard lock(mutex_);
    if (lifecycle_ == Lifecycle::Paused) return {{"changed", false}, {"lifecycle", "PAUSED"}};
    if (lifecycle_ != Lifecycle::Running) throw std::logic_error("simulation is not running");
    transition(Lifecycle::Paused);
    return {
        {"changed", true},
        {"lifecycle", "PAUSED"},
        {"simulated_seconds", virtual_s_},
        {"state_revision", graph_->state_revision()}
    };
}

nlohmann::json SimulationEngine::play() {
    std::lock_guard lock(mutex_);
    if (lifecycle_ == Lifecycle::Running) return {{"changed", false}, {"lifecycle", "RUNNING"}};
    if (lifecycle_ != Lifecycle::Paused && lifecycle_ != Lifecycle::Ready) {
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
    if (lifecycle_ == Lifecycle::Running || lifecycle_ == Lifecycle::Paused) stop();
    graph_.reset();
    run_id_.clear();
    virtual_s_ = 0;
    news_.clear();
    commands_.clear();
    redo_.clear();
    checkpoints_.clear();
    transition(Lifecycle::Idle);
    return {{"ok", true}, {"lifecycle", "IDLE"}};
}

nlohmann::json SimulationEngine::seek(std::uint32_t target, bool resume) {
    std::lock_guard lock(mutex_);
    if (!graph_ || target > day_s) throw std::invalid_argument("target time outside virtual day");
    const auto was_running = lifecycle_ == Lifecycle::Running;
    transition(Lifecycle::Seeking);
    restore_to(target);
    transition((resume || was_running) ? Lifecycle::Running : Lifecycle::Paused);
    anchor_wall_clock();
    cv_.notify_all();
    return {
        {"target_time", hhmmss(target)},
        {"simulated_seconds", target},
        {"lifecycle", to_string(lifecycle_)},
        {"state_revision", graph_->state_revision()}
    };
}

AppliedCommand& SimulationEngine::record(std::string type, nlohmann::json before, nlohmann::json after) {
    redo_.clear();
    commands_.push_back({next_command_id_++, std::move(type), "applied", virtual_s_, std::move(before), std::move(after)});
    logger_.event(run_id_, commands_.back().id, "control", "applied", virtual_s_, commands_.back().after.dump());
    return commands_.back();
}

nlohmann::json SimulationEngine::set_tick_rate(double v) {
    std::lock_guard lock(mutex_);
    if (!std::isfinite(v) || v <= 0 || v > 100) throw std::invalid_argument("tick_rate must be finite and in (0,100]");
    if (lifecycle_ == Lifecycle::Running) {
        const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - anchor_wall_).count();
        step_to(std::min(day_s, anchor_virtual_s_ + static_cast<std::uint32_t>(elapsed * (day_s / double(graph_->scenario().config.playback_duration_s)) * tick_rate_)));
    }
    const auto old = tick_rate_;
    tick_rate_ = v;
    ++config_revision_;
    auto& c = record("tick_rate", {{"tick_rate", old}}, {{"tick_rate", v}});
    anchor_wall_clock();
    return {
        {"command_id", c.id},
        {"previous_tick_rate", old},
        {"tick_rate", v},
        {"base_rate", graph_ ? day_s / double(graph_->scenario().config.playback_duration_s) : 0},
        {"target_virtual_rate", graph_ ? day_s / double(graph_->scenario().config.playback_duration_s) * v : 0}
    };
}

nlohmann::json SimulationEngine::set_day(int v) {
    std::lock_guard lock(mutex_);
    if (v != 0 && v != 1) throw std::invalid_argument("day must be 0 or 1");
    if (!graph_) throw std::logic_error("no active simulation");
    const auto old = graph_->scenario().config.day;
    const_cast<ScenarioConfig&>(graph_->scenario().config).day = v;
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
    if (!std::isfinite(intensity) || !std::isfinite(radius) || !std::isfinite(gain) || intensity < 0 || intensity > 1 || radius <= 0 || duration == 0 || gain < 0 || gain > 1) {
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
    auto& s = graph_->edge_state(id);
    nlohmann::json before{{"edge", id.value}, {"speed_multiplier", s.manual_speed_multiplier}, {"capacity_multiplier", s.manual_capacity_multiplier}, {"closed", s.manual_closed}};
    s.manual_speed_multiplier = sm;
    s.manual_capacity_multiplier = cm;
    s.manual_closed = closed;
    s.closed = closed || s.flood >= .95;
    graph_->commit();
    auto& c = record("edge_override", before, {{"edge", id.value}, {"speed_multiplier", sm}, {"capacity_multiplier", cm}, {"closed", closed}});
    return {{"command_id", c.id}, {"edge_id", id.value}, {"state_revision", graph_->state_revision()}};
}

void SimulationEngine::apply_command(const AppliedCommand& c, bool forward) {
    const auto& v = forward ? c.after : c.before;
    if (c.type == "tick_rate") {
        tick_rate_ = v.at("tick_rate");
        anchor_wall_clock();
    } else if (c.type == "day") {
        const_cast<ScenarioConfig&>(graph_->scenario().config).day = v.at("day");
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
        auto& s = graph_->edge_state(EdgeId{v.at("edge").get<std::uint32_t>()});
        s.manual_speed_multiplier = v.at("speed_multiplier");
        s.manual_capacity_multiplier = v.at("capacity_multiplier");
        s.manual_closed = v.at("closed");
        s.closed = s.manual_closed || s.flood >= .95;
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
    const auto day_profile = std::sin((double(virtual_s_) / day_s * 2 * 3.141592653589793) - 1.2) * .5 + .5;

    for (const auto& n : sc.nodes) {
        auto& ns = graph_->node_state(n.id);
        double building = 0;
        if (sc.config.buildings && n.building) {
            for (const auto& w : n.tmax) {
                building = 1 - (1 - building) * (1 - temporal_beta(now_ppm, w));
            }
            double weekend = 1;
            if (sc.config.day == 1) {
                weekend = (*n.building == BuildingType::School ? .1 :
                           *n.building == BuildingType::Office ? .35 :
                           *n.building == BuildingType::Mall ? 1.25 : 1.15);
            }
            building = clamp01(building * n.building_impact * weekend);
        }

        // Specific Peak-Hour surges for Schools, Offices, Malls, Shops, and Bus Stops
        const double day_hour = (double(virtual_s_) / 3600.0);
        double poi_rush = 0.0;
        if (n.building) {
            switch (*n.building) {
                case BuildingType::School:
                    // Morning drop-off (07:45 - 09:15) & afternoon dismissal (14:30 - 16:00)
                    if (sc.config.day == 0) {
                        if ((day_hour >= 7.75 && day_hour <= 9.25) || (day_hour >= 14.5 && day_hour <= 16.0)) {
                            poi_rush = 0.65;
                        }
                    }
                    break;
                case BuildingType::Office:
                    // Morning commute (08:15 - 10:00) & evening commute (17:00 - 19:30)
                    if (sc.config.day == 0) {
                        if ((day_hour >= 8.25 && day_hour <= 10.0) || (day_hour >= 17.0 && day_hour <= 19.5)) {
                            poi_rush = 0.75;
                        }
                    }
                    break;
                case BuildingType::Mall:
                    // Lunch rush (12:00 - 14:00) & evening peak (18:00 - 21:30)
                    if ((day_hour >= 12.0 && day_hour <= 14.0) || (day_hour >= 18.0 && day_hour <= 21.5)) {
                        poi_rush = (sc.config.day == 1 ? 0.85 : 0.60);
                    }
                    break;
                case BuildingType::Store:
                    // Commercial shopping hours (11:00 - 20:00)
                    if (day_hour >= 11.0 && day_hour <= 20.0) {
                        poi_rush = 0.45;
                    }
                    break;
            }
        }
        if (n.bus_stop) {
            // Commute rush hours at transit stops
            if ((day_hour >= 7.5 && day_hour <= 9.5) || (day_hour >= 16.5 && day_hour <= 19.0)) {
                poi_rush = std::max(poi_rush, 0.40);
            }
        }
        building = clamp01(building + poi_rush);
        ns.building_effect = building;

        double rain = 0;
        auto consume = [&](const DwsEvent& e) {
            if (e.epicenter.value >= sc.nodes.size()) return;
            const auto storm = evaluate_storm_state(e, now_ppm, sc.nodes[e.epicenter.value]);
            if (!storm.active) return;
            const double dist = std::hypot(n.position.x_m - storm.cur_x_m, n.position.y_m - storm.cur_y_m);
            rain = 1.0 - (1.0 - rain) * (1.0 - storm.cur_intensity * wendland_c2(dist, storm.cur_radius_m));
        };
        if (sc.config.dws) {
            for (const auto& e : sc.dws_events) consume(e);
            for (const auto& e : manual_weather_) consume(e);
        }
        ns.rainfall = clamp01(rain);

        if (sc.config.flooding) {
            const auto gain = .018 * ns.rainfall * n.flood_susceptibility;
            const auto drain = .004 * n.drainage * ns.flood;
            ns.flood = clamp01(ns.flood + dt * (gain - drain));
        } else {
            ns.flood = 0;
        }
    }

    for (const auto& e : sc.edges) {
        auto& es = graph_->edge_state(e.id);
        const auto& na = graph_->node_states()[e.from.value];
        const auto& nb = graph_->node_states()[e.to.value];
        es.rainfall = (na.rainfall + nb.rainfall) / 2;
        es.flood = (na.flood + nb.flood) / 2;
        const auto attraction = (na.building_effect + nb.building_effect) / 2;
        const auto hot = sc.config.traffic ? e.hotspot_susceptibility : 0;
        es.demand_vph = sc.config.traffic ? e.base_capacity_vph * (.18 + .68 * day_profile + .60 * attraction + .35 * hot) : 0;
        if (sc.config.signals && e.to.value < signal_by_node_.size() && signal_by_node_[e.to.value] != nullptr) {
            const auto* sig = signal_by_node_[e.to.value];
            const auto cycle = sig->cycle_s > 0 ? sig->cycle_s : 60;
            const auto t_in_cycle = (virtual_s_ + e.to.value * 7) % cycle;
            const auto& p = sig->phases_s;
            const std::uint16_t p0 = p.size() > 0 ? p[0] : 30;
            const std::uint16_t p1 = p.size() > 1 ? p[1] : 3;
            const std::uint16_t p2 = p.size() > 2 ? p[2] : 1;
            const std::uint16_t p3 = p.size() > 3 ? p[3] : 20;
            const std::uint16_t p4 = p.size() > 4 ? p[4] : 3;
            const bool is_major = (e.id.value % 2 == 0);
            if (is_major) {
                if (t_in_cycle < p0) {
                    es.signal_multiplier = 1.0;
                } else if (t_in_cycle < p0 + p1) {
                    es.signal_multiplier = 0.45;
                } else {
                    es.signal_multiplier = (cycle >= 90) ? 0.12 : 0.20;
                }
            } else {
                const std::uint32_t m_green_start = static_cast<std::uint32_t>(p0 + p1 + p2);
                const std::uint32_t m_green_end = static_cast<std::uint32_t>(m_green_start + p3);
                const std::uint32_t m_yellow_end = static_cast<std::uint32_t>(m_green_end + p4);
                if (t_in_cycle >= m_green_start && t_in_cycle < m_green_end) {
                    es.signal_multiplier = 1.0;
                } else if (t_in_cycle >= m_green_end && t_in_cycle < m_yellow_end) {
                    es.signal_multiplier = 0.45;
                } else {
                    es.signal_multiplier = (cycle >= 90) ? 0.12 : 0.20;
                }
            }
        } else {
            es.signal_multiplier = 1.0;
        }
        es.rain_speed_multiplier = 1 - .32 * es.rainfall;
        es.flood_speed_multiplier = std::max(.05, 1 - .8 * es.flood);
        es.rain_capacity_multiplier = 1 - .25 * es.rainfall;
        es.flood_capacity_multiplier = std::max(.02, 1 - .9 * es.flood);
        es.effective_speed_mps = e.free_speed_mps * std::max(0.25, es.signal_multiplier) * es.rain_speed_multiplier * es.flood_speed_multiplier * es.manual_speed_multiplier;
        es.effective_capacity_vph = e.base_capacity_vph * es.signal_multiplier * es.rain_capacity_multiplier * es.flood_capacity_multiplier * es.manual_capacity_multiplier;
        es.closed = es.manual_closed || es.flood >= .95;
        const auto x = es.demand_vph / std::max(1.0, es.effective_capacity_vph);
        const auto delay = .15 * std::pow(x, 4);
        es.congestion_model = delay / (1 + delay);

        // Microscopic vehicle density calculation:
        // Real-world density k = demand / speed, scaling naturally with queue congestion
        const double density_km = (es.demand_vph / std::max(2.0, es.effective_speed_mps * 3.6)) * (1.0 + 3.0 * es.congestion_model);
        const double expected_veh = density_km * (e.length_m / 1000.0);
        const double hash_sample = (static_cast<std::uint64_t>(e.id.value * 2654435761u + (virtual_s_ / 60) * 1013904223u) % 10000) / 10000.0;
        std::uint32_t veh_cnt = static_cast<std::uint32_t>(std::floor(expected_veh));
        if (hash_sample < (expected_veh - std::floor(expected_veh))) {
            veh_cnt++;
        }
        if (sc.config.traffic && (attraction > 0.25 || hot > 0.35 || es.congestion_model > 0.30)) {
            veh_cnt = std::max<std::uint32_t>(veh_cnt, static_cast<std::uint32_t>(std::ceil(expected_veh * 1.6)));
        }
        es.vehicle_count = veh_cnt;
        es.mean_speed_mps = es.effective_speed_mps * (1 - es.congestion_model * .72);
        es.halting_count = static_cast<std::uint32_t>(std::llround(es.vehicle_count * es.congestion_model));
        es.occupancy = clamp01(es.vehicle_count * 5.0 / (std::max(1.0, e.length_m) * e.lanes));
        es.congestion_observed = 1 - (1 - clamp01(1 - es.mean_speed_mps / std::max(.1, es.effective_speed_mps))) * (1 - double(es.halting_count) / std::max(1u, es.vehicle_count)) * (1 - es.occupancy);
        es.congestion = clamp01(.45 * es.congestion_model + .55 * es.congestion_observed);
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

    if (sc.config.traffic && (virtual_s_ % 300 == 0) && virtual_s_ > 0) {
        for (const auto& e : sc.edges) {
            const auto& es = graph_->edge_state(e.id);
            if (es.closed && es.flood >= 0.85 && (virtual_s_ % 900 == 0)) {
                add_news(200000 + e.id.value, "safety", "alert", "ROAD_FLOOD_CLOSED",
                         "[" + hhmmss(virtual_s_) + "] Road " + std::to_string(e.id.value) + " (" + to_string(e.road_class) +
                         ") is impassable due to severe flood inundation.",
                         {{"edge_id", e.id.value}, {"flood", es.flood}});
                break;
            } else if (es.congestion >= 0.80 && (virtual_s_ % 600 == 0)) {
                add_news(300000 + e.id.value, "traffic", "warning", "TRAFFIC_BOTTLENECK",
                         "[" + hhmmss(virtual_s_) + "] Heavy congestion on Road " + std::to_string(e.id.value) +
                         " (" + to_string(e.road_class) + "): " + std::to_string(es.vehicle_count) + " vehicles queued, speed reduced to " +
                         std::to_string(static_cast<int>(es.effective_speed_mps * 3.6)) + " km/h.",
                         {{"edge_id", e.id.value}, {"congestion", es.congestion}, {"vehicles", es.vehicle_count}});
                break;
            }
        }
    }

    auto notify_time = [&](std::uint32_t t_sec, std::uint64_t ev_id, const std::string& cat, const std::string& sev, const std::string& tmpl, const std::string& msg) {
        if (previous < t_sec && virtual_s_ >= t_sec) {
            add_news(ev_id, cat, sev, tmpl, msg);
        }
    };
    notify_time(8 * 3600 + 30 * 60, 400001, "transit", "info", "SCHOOL_RUSH_START",
                "[08:30:00] Morning school bell surge: high pedestrian and student transit activity around school zones.");
    notify_time(9 * 3600 + 15 * 60, 400002, "traffic", "warning", "COMMERCIAL_PEAK_HOUR",
                "[09:15:00] Commercial district peak inbound traffic: arterial corridors operating near maximum capacity.");
    notify_time(12 * 3600 + 30 * 60, 400003, "transit", "info", "MIDDAY_COMMERCIAL_SURGE",
                "[12:30:00] Midday dining and retail transit increase around mall and commercial sectors.");
    notify_time(17 * 3600 + 30 * 60, 400004, "traffic", "warning", "EVENING_RUSH_HOUR",
                "[17:30:00] Evening outbound rush hour: widespread arterial delays and high occupancy across transit corridors.");
    notify_time(21 * 3600, 400005, "transit", "info", "NIGHT_TRANSIT_MODE",
                "[21:00:00] Night-time transit schedule initiated; off-peak speed profiles active.");

    if (sc.config.signals && (virtual_s_ % 7200 == 0) && virtual_s_ > 0) {
        add_news(500000 + (virtual_s_ / 7200), "signals", "info", "SIGNAL_SYNC",
                 "[" + hhmmss(virtual_s_) + "] Adaptive traffic signal corridor timing synchronized across " +
                 std::to_string(sc.signals.size()) + " intersections.");
    }
    graph_->commit();
}

void SimulationEngine::step_to(std::uint32_t target) {
    target = std::min(target, day_s);
    while (virtual_s_ < target) {
        const auto dt = std::min<std::uint32_t>(60, target - virtual_s_);
        virtual_s_ += dt;
        physics_step(dt);
        if (virtual_s_ % 900 == 0) {
            checkpoints_.push_back({virtual_s_, graph_->node_states(), graph_->edge_states(), news_.size()});
        }
    }
    if (virtual_s_ >= day_s && lifecycle_ == Lifecycle::Running) {
        transition(Lifecycle::Completed);
    }
}

void SimulationEngine::restore_to(std::uint32_t target) {
    auto it = std::upper_bound(checkpoints_.begin(), checkpoints_.end(), target, [](auto t, const Checkpoint& c) {
        return t < c.virtual_s;
    });
    if (it != checkpoints_.begin()) --it;
    graph_->reset_dynamic();
    virtual_s_ = 0;
    if (it != checkpoints_.end()) {
        virtual_s_ = it->virtual_s;
        for (std::size_t i = 0; i < it->nodes.size(); ++i) graph_->node_state(NodeId{static_cast<std::uint32_t>(i)}) = it->nodes[i];
        for (std::size_t i = 0; i < it->edges.size(); ++i) graph_->edge_state(EdgeId{static_cast<std::uint32_t>(i)}) = it->edges[i];
        if (news_.size() > it->news_size) news_.resize(it->news_size);
    }
    step_to(target);
}

void SimulationEngine::loop() {
    std::unique_lock lock(mutex_);
    while (!terminate_requested_) {
        cv_.wait_for(lock, std::chrono::milliseconds(50));
        if (terminate_requested_) break;
        if (!graph_) continue;

        if (lifecycle_ == Lifecycle::Running) {
            const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - anchor_wall_).count();
            const auto rate = day_s / double(graph_->scenario().config.playback_duration_s) * tick_rate_;
            step_to(std::min(day_s, anchor_virtual_s_ + static_cast<std::uint32_t>(elapsed * rate)));
        }

        const auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - last_global_dump_).count() >= 1.0) {
            last_global_dump_ = now;
            try {
                const auto gv = global_view();
                logger_.write_file("global_view.json", gv.dump(2));
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
        {"state_revision", graph_ ? graph_->state_revision() : 0},
        {"config_revision", config_revision_},
        {"clock", clock_json()},
        {"data", std::move(data)}
    };
}

nlohmann::json SimulationEngine::status() const {
    std::lock_guard lock(mutex_);
    return envelope({
        {"lifecycle", to_string(lifecycle_)},
        {"run_id", run_id_},
        {"day", graph_ ? graph_->scenario().config.day : -1},
        {"paused", lifecycle_ == Lifecycle::Paused},
        {"simulated_seconds", virtual_s_},
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
            {"signal", n.signal},
            {"building", n.building ? nlohmann::json(to_string(*n.building)) : nlohmann::json(nullptr)}
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
            {"length_m", e.length_m},
            {"free_speed_mps", e.free_speed_mps},
            {"lanes", e.lanes},
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
    return envelope({
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
            {"closed", s.closed}
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
    for (const auto& e : graph_->scenario().dws_events) check_weather(e);
    for (const auto& e : manual_weather_) check_weather(e);

    nlohmann::json active_incidents = nlohmann::json::array();
    for (std::size_t i = 0; i < graph_->edges().size(); ++i) {
        const auto& e = graph_->edges()[i];
        const auto& s = graph_->edge_states()[i];
        if (s.closed || s.congestion >= 0.70 || s.flood >= 0.50) {
            active_incidents.push_back({
                {"edge_id", e.id.value},
                {"from_node", e.from.value},
                {"to_node", e.to.value},
                {"road_class", to_string(e.road_class)},
                {"congestion", s.congestion},
                {"flood", s.flood},
                {"closed", s.closed},
                {"effective_speed_mps", s.effective_speed_mps},
                {"vehicle_count", s.vehicle_count}
            });
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
            {"category", n.category},
            {"severity", n.severity},
            {"template_id", n.template_id},
            {"message", n.message},
            {"data", n.data}
        });
    }

    return envelope({
        {"topology_revision", 1},
        {"nodes", std::move(ns)},
        {"edges", std::move(es)},
        {"active_weather_events", active_weather_list.size()},
        {"active_weather", std::move(active_weather_list)},
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
        {"seed", s.seed.hex()},
        {"map_hash", s.map_hash},
        {"graph_hash", s.graph_hash},
        {"event_hash", s.event_hash},
        {"scenario_hash", s.scenario_hash},
        {"map_source", s.config.osm_file.empty() ? "offline-deterministic-road-fixture" : "osm-xml"},
        {"road_filter_version", "road-only/v1"}
    });
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
    } else if (kind == "signals") {
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
        std::vector<double> congestion;
        for (std::size_t i = 0; i < sc.edges.size(); ++i) {
            const auto& e = sc.edges[i];
            const auto& s = graph_->edge_states()[i];
            weighted += e.length_m * s.congestion;
            length += e.length_m;
            speed_sum += s.mean_speed_mps;
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
            {"mean_vehicle_speed_mps", speed_sum / std::max<std::size_t>(1, sc.edges.size())},
            {"vehicle_count", vehicles},
            {"halting_vehicle_count", halting},
            {"active_dws_events", std::count_if(sc.dws_events.begin(), sc.dws_events.end(), [&](const auto& e) {
                auto now = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);
                return now >= e.start_ppm && now < e.end_ppm;
            })},
            {"hotspot_edge_count", sc.hotspot_edges.size()}
        });
    } else {
        throw std::invalid_argument("unknown view catalog: " + kind);
    }
    return envelope({{"items", std::move(items)}});
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

std::uint64_t SimulationEngine::state_revision() const {
    std::lock_guard lock(mutex_);
    return graph_ ? graph_->state_revision() : 0;
}

Lifecycle SimulationEngine::lifecycle() const {
    std::lock_guard lock(mutex_);
    return lifecycle_;
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
    double sum_congestion = 0;
    std::size_t flooded_edges = 0;
    std::size_t closed_edges = 0;

    for (std::size_t i = 0; i < graph_->edges().size(); ++i) {
        const auto& e = graph_->edges()[i];
        const auto& es = graph_->edge_states()[i];

        total_vehicles += es.vehicle_count;
        sum_speed_mps += es.effective_speed_mps;
        sum_congestion += es.congestion;
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
    const double mean_congestion = sum_congestion / edge_count_d;

    nlohmann::json active_weather_list = nlohmann::json::array();
    nlohmann::json scheduled_weather_list = nlohmann::json::array();
    const auto now_ppm = std::uint32_t(std::uint64_t(virtual_s_) * ppm / day_s);

    auto inspect_event = [&](const DwsEvent& ev) {
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
    for (std::size_t i = 0; i < graph_->edges().size(); ++i) {
        const auto& e = graph_->edges()[i];
        const auto& s = graph_->edge_states()[i];
        if (s.closed || s.congestion >= 0.70 || s.flood >= 0.50) {
            active_incidents.push_back({
                {"edge_id", e.id.value},
                {"from_node", e.from.value},
                {"to_node", e.to.value},
                {"road_class", to_string(e.road_class)},
                {"congestion", s.congestion},
                {"flood", s.flood},
                {"closed", s.closed},
                {"effective_speed_mps", s.effective_speed_mps},
                {"effective_speed_kmh", s.effective_speed_mps * 3.6},
                {"vehicle_count", s.vehicle_count}
            });
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
        {"product", "Deterministic Simulated Environment"},
        {"version", "1.0.0"},
        {"lifecycle", to_string(lifecycle_)},
        {"run_id", run_id_},
        {"global_seed", sc.seed.hex()},
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
            {"mean_network_congestion", mean_congestion},
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
    std::lock_guard lock(mutex_);
    if (!graph_) throw std::logic_error("no active simulation");
    auto res = SumoBridge::simulate(graph_->scenario(), directory, begin_s, end_s);
    return envelope(std::move(res));
}

void SimulationEngine::terminate() {
    std::lock_guard lock(mutex_);
    if (terminate_requested_) return;
    transition(Lifecycle::Terminating);
    terminate_requested_ = true;
    cv_.notify_all();
    worker_.request_stop();
}

} // namespace dstns

