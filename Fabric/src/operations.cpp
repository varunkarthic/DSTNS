// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "operations.hpp"

#include "support.hpp"

#include <cmath>
#include <map>
#include <stdexcept>

namespace dstns::fabric {

json add_weather(SimulationEngine& engine, const json& j) {
    const double default_rad = 350.0;
    const double minutes = j.value("duration_virtual_minutes", 60.0);
    // Checked as a double: converting a negative or enormous value to an
    // unsigned integer first would be undefined.
    if (!std::isfinite(minutes) || minutes < 1 || minutes > 1440)
        throw std::invalid_argument("duration_virtual_minutes must be in [1, 1440]");
    return engine.add_weather(
        NodeId{j.at("epicenter_node")},
        j.value("intensity", 0.85),
        j.value("radius_m", default_rad),
        static_cast<std::uint32_t>(minutes),
        j.value("flood_gain", 0.5)
    );
}

json add_traffic(SimulationEngine& engine, const json& j) {
    const auto target = j.at("target");
    if (target.at("type") != "edge") throw std::invalid_argument("V1 traffic overlays require an edge target");
    const auto pressure = j.at("congestion_pressure").get<double>();
    if (!std::isfinite(pressure) || pressure < 0 || pressure > 1) {
        throw std::invalid_argument("congestion_pressure must be in [0,1]");
    }
    return engine.override_edge(EdgeId{target.at("id").get<std::uint32_t>()}, 1.0, 1.0 - .75 * pressure, false);
}

json add_surge(SimulationEngine& engine, const json& j) {
    return engine.trigger_surge(
        NodeId{j.at("node_id")},
        j.value("factor", 1.8),
        j.value("radius_m", 350.0),
        j.value("duration_s", 1800u)
    );
}

json override_edge(SimulationEngine& engine, std::uint32_t edge, const json& j) {
    return engine.override_edge(
        EdgeId{edge},
        j.value("speed_multiplier", 1.0),
        j.value("capacity_multiplier", 1.0),
        j.value("closed", false)
    );
}

// Advance a fixed amount of virtual time and hold there.
json step(SimulationEngine& engine, const json& j) {
    const auto seconds = j.contains("seconds") ? j.at("seconds").get<std::int64_t>() : 60;
    if (seconds < 1 || seconds > 3600) throw std::invalid_argument("seconds must be in [1, 3600]");
    return engine.step(static_cast<std::uint32_t>(seconds));
}

// Read as a signed integer: nlohmann converts -1 to an unsigned type by
// wrapping it, which would undo the whole history.
std::uint32_t history_count(const json& j) {
    const auto count = j.value("count", std::int64_t{1});
    if (count < 1 || count > 10000) throw std::invalid_argument("count must be in [1, 10000]");
    return static_cast<std::uint32_t>(count);
}

std::string control_capability(const std::string& action) {
    static const std::map<std::string, std::string> capabilities = {
        {"play", "control.playback"}, {"pause", "control.playback"}, {"seek", "control.playback"}, {"step", "control.playback"},
        {"tick_rate", "control.playback"}, {"reset", "control.playback"},
        {"weather", "control.events"}, {"traffic", "control.events"}, {"surge", "control.events"}, {"edge_override", "control.events"},
        {"signal_toggle", "control.events"}, {"day", "control.events"}, {"module", "control.events"}, {"undo", "control.events"}, {"redo", "control.events"},
        {"regenerate", "control.world"}};
    const auto found = capabilities.find(action);
    return found == capabilities.end() ? std::string{} : found->second;
}

json perform_control(SimulationEngine& engine, const std::string& action, const json& p) {
    if (action == "play") return engine.play(p);
    if (action == "pause") return engine.pause(p);
    if (action == "seek") return engine.seek(time_value(p.at("target_time")), p.value("play", false));
    if (action == "step") return step(engine, p);
    if (action == "tick_rate") return engine.set_tick_rate(p.at("tick_rate"));
    if (action == "reset") return engine.reset();
    if (action == "weather") return add_weather(engine, p);
    if (action == "traffic") return add_traffic(engine, p);
    if (action == "surge") return add_surge(engine, p);
    if (action == "edge_override") return override_edge(engine, p.at("edge").get<std::uint32_t>(), p);
    if (action == "signal_toggle") return engine.toggle_signal(NodeId{p.at("node").get<std::uint32_t>()});
    if (action == "day") return engine.set_day(p.at("day"));
    if (action == "module") return engine.set_module(p.at("module").get<std::string>(), p.at("enabled"));
    if (action == "undo") return engine.undo(history_count(p));
    if (action == "redo") return engine.redo(history_count(p));
    if (action == "regenerate") return engine.regenerate_world(p);
    throw std::invalid_argument("unknown control action: " + action);
}
} // namespace dstns::fabric
