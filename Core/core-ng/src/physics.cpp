// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's physics tick (engine 3.7.0, core-ng 0.7.0): its own copy of the tick and of the weather and incident
// helpers it uses, generated from core-legacy's (Core/core-legacy/src/physics.cpp) with every expression unchanged.
// It shares only the interface (physics::Context and the structs in dstns/physics.hpp). dstns_golden proves the runtime
// snapshots of core-ng worlds are identical to core-legacy's, to the last bit.
#include "dstns/core-ng/physics.hpp"

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <sstream>

namespace dstns::core_ng {
namespace {
using physics::day_s;
using physics::ppm;
using physics::NewsDraft;
using physics::StormAtmosphericState;
using physics::StormTimes;

std::string hhmmss(std::uint32_t s) {
    s %= day_s;
    std::ostringstream o;
    o << std::setfill('0') << std::setw(2) << s / 3600 << ':' << std::setw(2) << (s % 3600) / 60 << ':' << std::setw(2) << s % 60;
    return o.str();
}
double clamp01(double x) { return std::clamp(x, 0.0, 1.0); }
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
} // namespace

void physics_step(physics::Context& ctx, std::uint32_t dt) {
    const auto& sc = ctx.graph.scenario();
    const auto now_ppm = std::uint32_t(std::uint64_t(ctx.virtual_s) * ppm / day_s);
    for(const auto& event:ctx.events.advance(sc,ctx.virtual_s)) {
        if(sc.config.buildings) ctx.add_news(event.sequence,"demand",event.value>1?"warning":"info","DEMAND_CHANGED",event.description,{{"feature_id",sc.features[event.entity].id},{"multiplier",event.value}});
    }
    const auto day_profile = std::sin((double(ctx.virtual_s) / day_s * 2 * 3.141592653589793) - 1.2) * .5 + .5;

    // A storm's position and strength depend on the clock alone, so evaluate
    // each once per tick rather than once per junction; the per-junction loop
    // then combines them in the same order, which keeps every result identical.
    auto& node_states = ctx.graph.node_states_mut();
    auto& edge_states = ctx.graph.edge_states_mut();
    struct ActiveStorm { double x_m, y_m, radius_m, intensity; };
    std::vector<ActiveStorm> storms;
    if (sc.config.dws) {
        auto consider = [&](const DwsEvent& e) {
            if (e.epicenter.value >= sc.nodes.size()) return;
            const auto storm = evaluate_storm_state(e, now_ppm, sc.nodes[e.epicenter.value]);
            if (storm.active) storms.push_back({storm.cur_x_m, storm.cur_y_m, storm.cur_radius_m, storm.cur_intensity});
        };
        for (const auto& e : sc.dws_events) consider(e);
        for (const auto& e : ctx.manual_weather) consider(e);
    }

    for (const auto& n : sc.nodes) {
        auto& ns = node_states[n.id.value];
        ns.building_effect = 0;

        double rain = 0;
        for (const auto& storm : storms) {
            const double dist = std::hypot(n.position.x_m - storm.x_m, n.position.y_m - storm.y_m);
            rain = 1.0 - (1.0 - rain) * (1.0 - storm.intensity * wendland_c2(dist, storm.radius_m));
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

    // Reset incident impact on all edges each physics tick
    for (auto& es : edge_states) {
        es.incident_speed_multiplier = 1.0;
        es.incident_capacity_multiplier = 1.0;
        es.incident_closed = false;
    }

    // Apply active incidents with safe overlapping composition
    if (sc.config.incidents) {
        for (const auto& inc : sc.incidents) {
            if (ctx.virtual_s >= inc.start_virtual_s && ctx.virtual_s < inc.end_virtual_s) {
                if (inc.edge.value < edge_states.size()) {
                    auto& es = edge_states[inc.edge.value];
                    es.incident_speed_multiplier = std::min(es.incident_speed_multiplier, inc.speed_multiplier);
                    es.incident_capacity_multiplier = std::min(es.incident_capacity_multiplier, inc.capacity_multiplier);
                    if (inc.closed) {
                        es.incident_closed = true;
                    }
                }
            }
        }
    }

    // Surges, like storms, are a function of the clock: shape each once.
    struct ActiveSurge { Point centre; double factor, radius_m; };
    std::vector<ActiveSurge> surges;
    for (const auto& s : ctx.active_surges) {
        if (ctx.virtual_s >= s.start_s && ctx.virtual_s <= s.end_s && s.end_s > s.start_s) {
            const double rel_t = double(ctx.virtual_s - s.start_s) / double(s.end_s - s.start_s);
            const double bell = std::sin(3.141592653589793 * rel_t);
            const double bell_weight = bell * bell;
            surges.push_back({sc.nodes[s.node.value].position, 1.0 + (s.factor - 1.0) * bell_weight,
                              s.radius_m * (0.35 + 0.65 * bell_weight)});
        }
    }

    for (const auto& e : sc.edges) {
        auto& es = edge_states[e.id.value];
        const auto& na = node_states[e.from.value];
        const auto& nb = node_states[e.to.value];
        es.rainfall = (na.rainfall + nb.rainfall) / 2;
        const bool was_flooded=es.flood>.01;
        es.flood = (na.flood + nb.flood) / 2;
        if(is_source_direction_allowed(e) && was_flooded!=(es.flood>.01)){
            ctx.events.observe({ctx.virtual_s,e.id.value,0,0,"flooding",es.flood>.01?"Road becomes flood affected":"Flood effect cleared",es.flood});
            if(es.flood>.01 && e.id.value%2==0) ctx.add_news(800000+e.id.value,"flooding","warning","FLOOD_STARTED","Flooding detected on Edge "+std::to_string(e.id.value),{{"edge_id",e.id.value},{"flood",es.flood}});
        }
        if (!is_source_direction_allowed(e)) {
            es.demand_vph = 0;
            es.effective_capacity_vph = 0;
            es.effective_speed_mps = 0;
            es.congestion_model = 0;
            es.congestion_observed = 0;
            es.congestion = 0;
            es.vehicle_load = 0;
            es.vehicle_count = 0;
            es.halting_count = 0;
            es.mean_speed_mps = 0;
            es.occupancy = 0;
            continue;
        }
        const auto attraction = sc.config.buildings ? ctx.events.demand_effect(e.id) : 0.0;
        const auto hot = sc.config.traffic ? e.hotspot_susceptibility : 0;
        
        // Active Surge Multiplier following a smooth Gaussian / Normal Distribution curve
        double surge_mult = 1.0;
        for (const auto& s : surges) {
            const double d1 = point_distance(sc.nodes[e.from.value].position, s.centre);
            const double d2 = point_distance(sc.nodes[e.to.value].position, s.centre);
            if (d1 <= s.radius_m || d2 <= s.radius_m) {
                surge_mult = std::max(surge_mult, s.factor);
            }
        }

        es.demand_vph = sc.config.traffic ? e.base_capacity_vph * (.18 + .68 * day_profile + .60 * attraction + .35 * hot) * surge_mult : 0;
        
        es.signal_multiplier = ctx.events.signal_multiplier(sc,e);
        if (ctx.signal_overrides.contains(e.to.value) && sc.config.signals) {
            const auto& a=sc.nodes[e.from.value].position;const auto& b=sc.nodes[e.to.value].position;
            bool ns=std::abs(b.y_m-a.y_m)>=std::abs(b.x_m-a.x_m);
            es.signal_multiplier=(ns==(ctx.signal_overrides.at(e.to.value)==1))?1.0:.08;
        }

        // Realistic Weather Sensitivity (Rain causes moderate 10-25% slowing rather than sudden impassability)
        es.rain_speed_multiplier = 1.0 - 0.18 * es.rainfall;
        es.flood_speed_multiplier = std::max(0.35, 1.0 - 0.55 * es.flood);
        es.rain_capacity_multiplier = 1.0 - 0.15 * es.rainfall;
        es.flood_capacity_multiplier = std::max(0.30, 1.0 - 0.60 * es.flood);

        // Smooth speed deceleration and acceleration curves (realistic gradual vehicle movement)
        const bool is_closed = es.manual_closed || es.incident_closed || es.flood >= 0.98;
        const double target_speed = is_closed ? 0.0 : (e.free_speed_mps * es.signal_multiplier * es.rain_speed_multiplier * es.flood_speed_multiplier * es.manual_speed_multiplier * es.incident_speed_multiplier);
        if (es.effective_speed_mps < target_speed) {
            es.effective_speed_mps = std::min(target_speed, es.effective_speed_mps + 2.4 * dt);
        } else if (es.effective_speed_mps > target_speed) {
            es.effective_speed_mps = std::max(target_speed, es.effective_speed_mps - 3.2 * dt);
        }

        es.effective_capacity_vph = e.base_capacity_vph * es.signal_multiplier * es.rain_capacity_multiplier * es.flood_capacity_multiplier * es.manual_capacity_multiplier * es.incident_capacity_multiplier;
        es.closed = is_closed;

        // Smooth physical vehicle queuing dynamics (eliminates abrupt 51 -> 2 jumps)
        const double baseline_veh = (es.demand_vph / std::max(2.0, e.free_speed_mps * 3.6)) * (e.length_m / 1000.0);
        const double max_queue_veh = (e.length_m / 7.5) * e.lanes;
        const double target_veh = es.closed ? 0.0 : std::clamp(baseline_veh * (1.0 + 3.5 * (1.0 - es.signal_multiplier) * (0.5 + 0.5 * surge_mult)), 0.0, max_queue_veh);

        const double current_veh = es.vehicle_load;
        double next_veh = current_veh;
        const double rate_factor = 1.0;
        if (target_veh > current_veh) {
            // Queue buildup: accumulates smoothly at physical inflow rate
            const double max_inflow_step = std::max(0.4, (es.demand_vph / 3600.0) * dt * rate_factor);
            next_veh = std::min(target_veh, current_veh + max_inflow_step);
        } else if (target_veh < current_veh) {
            // Queue discharge: drains smoothly at physical saturation flow rate
            const double max_discharge_step = std::max(0.7, (e.lanes * 0.75) * dt * rate_factor);
            next_veh = std::max(target_veh, current_veh - max_discharge_step);
        }

        es.vehicle_load=next_veh;
        es.vehicle_count = static_cast<std::uint32_t>(std::llround(next_veh));
        es.congestion_model = clamp01(double(es.vehicle_count) / std::max(1.0, max_queue_veh * 0.75));
        es.mean_speed_mps = es.effective_speed_mps * (1.0 - es.congestion_model * 0.65);
        es.halting_count = static_cast<std::uint32_t>(std::llround(es.vehicle_count * (1.0 - es.signal_multiplier * 0.9)));
        es.occupancy = clamp01(es.vehicle_count * 5.0 / (std::max(1.0, e.length_m) * e.lanes));
        es.congestion_observed = 1.0 - (1.0 - clamp01(1.0 - es.mean_speed_mps / std::max(0.1, es.effective_speed_mps))) * (1.0 - double(es.halting_count) / std::max(1u, es.vehicle_count)) * (1.0 - es.occupancy);
        const double speed_loss = es.vehicle_count ? clamp01(1.0-es.mean_speed_mps/std::max(.1,e.free_speed_mps)) : 0.0;
        const double queue_ratio = double(es.halting_count)/std::max(1u,es.vehicle_count);
        es.congestion = es.closed ? 1.0 : clamp01(.60*speed_loss+.25*queue_ratio+.15*es.occupancy);
    }

    const auto previous = ctx.virtual_s >= dt ? ctx.virtual_s - dt : 0;
    auto emit = [&](NewsDraft d) { ctx.add_news(d.event_id, d.category, d.severity, d.template_id, std::move(d.message), std::move(d.data)); };
    auto notify = [&](const DwsEvent& e) {
        const auto [start, peak, end] = storm_times(e);
        if (previous < start && ctx.virtual_s >= start) emit(rain_started(e, start));
        if (previous < peak && ctx.virtual_s >= peak && peak > start) emit(rain_peak(e, peak));
        if (previous < end && ctx.virtual_s >= end) emit(rain_ended(e, end));
    };
    if (sc.config.dws) {
        for (const auto& e : sc.dws_events) notify(e);
        for (const auto& e : ctx.manual_weather) notify(e);
    }

    // Active Deterministic Incident Lifecycle (Activation & Resolution)
    if (sc.config.incidents) {
        for (const auto& inc : sc.incidents) {
            if (previous < inc.start_virtual_s && ctx.virtual_s >= inc.start_virtual_s) emit(incident_started(inc));
            if (previous < inc.end_virtual_s && ctx.virtual_s >= inc.end_virtual_s) emit(incident_cleared(inc));
        }
    }

    ctx.congestion.update(sc,ctx.graph.edge_states(),ctx.virtual_s,dt);
    // Places respond to the conditions this tick produced: roads shut, rain
    // falling, an incident nearby. Run last, so couplings read the same state
    // the operator is about to be shown rather than the previous tick's.
    ctx.events.recouple(sc,ctx.graph.edge_states(),ctx.virtual_s);
    ctx.graph.commit();
}

} // namespace dstns::core_ng
