// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Weather and incident helpers: where a storm is and how strong at a moment, when it starts, peaks and ends, and the
// news each of these and each incident makes. Shared by the host's views and by core-legacy's tick; core-ng's tick has
// its own copy (Core/core-ng/src/physics.cpp).
#include "dstns/physics.hpp"

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <sstream>

namespace dstns::physics {
namespace {
std::string hhmmss(std::uint32_t s) {
    s %= day_s;
    std::ostringstream o;
    o << std::setfill('0') << std::setw(2) << s / 3600 << ':' << std::setw(2) << (s % 3600) / 60 << ':' << std::setw(2) << s % 60;
    return o.str();
}
double clamp01(double x) { return std::clamp(x, 0.0, 1.0); }
} // namespace
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

// The news an incident or a storm produces, composed in one place so the item
// the physics step emits and the narration prefetched for it when the world is
// installed are built from identical text and data.


NewsDraft incident_started(const Incident& inc) {
    const char* sev = "warning";
    if (inc.type == IncidentType::RoadClosure || inc.type == IncidentType::HazardSpill) sev = "alert";
    else if (inc.type == IncidentType::Congestion) sev = "info";
    const std::string level = std::string_view(sev) == "alert" ? "HIGH" : (std::string_view(sev) == "warning" ? "MID" : "LOW");
    return {inc.id, "incident", sev, "INCIDENT_ACTIVATED",
            "[" + hhmmss(inc.start_virtual_s) + "] " + inc.description + " on Edge #" + std::to_string(inc.edge.value) +
                " near Node #" + std::to_string(inc.node.value) + ". (" + level + " SEVERITY)",
            {{"incident_id", inc.id},
             {"type", to_string(inc.type)},
             {"edge_id", inc.edge.value},
             {"node_id", inc.node.value},
             {"speed_multiplier", inc.speed_multiplier},
             {"capacity_multiplier", inc.capacity_multiplier},
             {"closed", inc.closed},
             {"end_virtual_s", inc.end_virtual_s}},
            inc.start_virtual_s};
}

NewsDraft incident_cleared(const Incident& inc) {
    return {inc.id + 500000, "incident", "info", "INCIDENT_RESOLVED",
            "[" + hhmmss(inc.end_virtual_s) + "] Incident cleared on Edge #" + std::to_string(inc.edge.value) +
                " (" + to_string(inc.type) + "): Normal traffic flow restored.",
            {{"incident_id", inc.id},
             {"type", to_string(inc.type)},
             {"edge_id", inc.edge.value},
             {"node_id", inc.node.value}},
            inc.end_virtual_s};
}


StormTimes storm_times(const DwsEvent& e) {
    const auto start = std::uint32_t(std::uint64_t(e.start_ppm) * day_s / ppm);
    const auto end = std::uint32_t(std::uint64_t(e.end_ppm) * day_s / ppm);
    return {start, start + (end - start) / 2, end};
}

NewsDraft rain_started(const DwsEvent& e, std::uint32_t start) {
    return {e.id.value, "weather", "warning", "DWS_RAIN_STARTED",
            "[" + hhmmss(start) + "] Rain storm initiated at Node " + std::to_string(e.epicenter.value) +
                " (Radius: " + std::to_string(static_cast<int>(e.radius_m)) + "m, Intensity: " +
                std::to_string(static_cast<int>(e.intensity * 100)) + "%)",
            {{"epicenter", e.epicenter.value}, {"radius_m", e.radius_m}, {"intensity", e.intensity}}, start};
}

NewsDraft rain_peak(const DwsEvent& e, std::uint32_t peak) {
    return {e.id.value + 50000, "weather", "alert", "DWS_RAIN_PEAK",
            "[" + hhmmss(peak) + "] Peak precipitation & runoff at Node " + std::to_string(e.epicenter.value) +
                "; road friction reduced.",
            {{"epicenter", e.epicenter.value}, {"intensity", e.intensity}}, peak};
}

NewsDraft rain_ended(const DwsEvent& e, std::uint32_t end) {
    return {e.id.value + 100000, "weather", "info", "DWS_RAIN_ENDED",
            "[" + hhmmss(end) + "] Rain storm cleared at Node " + std::to_string(e.epicenter.value) +
                "; network returning to baseline conditions.",
            nlohmann::json{}, end};
}

} // namespace dstns::physics
