// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's physics tick (engine 3.7.0, core-ng 0.7.0): its own copy of the tick and of the weather and incident
// helpers it uses, generated from core-legacy's (Core/core-legacy/src/physics.cpp) with every expression unchanged.
// It shares only the interface (physics::Context and the structs in dstns/physics.hpp). dstns_golden proves the runtime
// snapshots of core-ng worlds are identical to core-legacy's, to the last bit.
#include "dstns/core-ng/physics.hpp"

#include <algorithm>
#include <cmath>
#include <memory>
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
// Per edge, what the tick derives from the static world alone (#23): computed once per world by the same expressions
// the tick used to evaluate every tick, so every value is the same to the last bit, and kept in sc.edges' order in a
// row about half the size of EdgeStatic.
struct EdgeRow {
    double base_capacity_vph, free_speed_mps, hotspot, length_m;
    double speed_floor_kmh;   // std::max(2.0, free_speed_mps * 3.6)
    double length_km;         // length_m / 1000.0
    double max_queue_veh;     // (length_m / 7.5) * lanes
    double congestion_room;   // std::max(1.0, max_queue_veh * 0.75)
    double occupancy_room;    // std::max(1.0, length_m) * lanes
    double free_speed_floor;  // std::max(.1, free_speed_mps)
    double weight;            // length_m * lanes
    double discharge_lanes;   // lanes * 0.75
    std::uint32_t id, from, to;
    bool allowed;
};

const std::vector<EdgeRow>& edge_rows(const GraphStore& graph) {
    if (auto cached = std::static_pointer_cast<const std::vector<EdgeRow>>(graph.derived())) return *cached;
    auto rows = std::make_shared<std::vector<EdgeRow>>();
    rows->reserve(graph.scenario().edges.size());
    for (const auto& e : graph.scenario().edges) {
        EdgeRow r{};
        r.base_capacity_vph = e.base_capacity_vph;
        r.free_speed_mps = e.free_speed_mps;
        r.hotspot = e.hotspot_susceptibility;
        r.length_m = e.length_m;
        r.speed_floor_kmh = std::max(2.0, e.free_speed_mps * 3.6);
        r.length_km = e.length_m / 1000.0;
        r.max_queue_veh = (e.length_m / 7.5) * e.lanes;
        r.congestion_room = std::max(1.0, r.max_queue_veh * 0.75);
        r.occupancy_room = std::max(1.0, e.length_m) * e.lanes;
        r.free_speed_floor = std::max(.1, e.free_speed_mps);
        r.weight = e.length_m * e.lanes;
        r.discharge_lanes = e.lanes * 0.75;
        r.id = e.id.value;
        r.from = e.from.value;
        r.to = e.to.value;
        r.allowed = is_source_direction_allowed(e);
        rows->push_back(r);
    }
    graph.set_derived(rows);
    return *rows;
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

    // Incidents (#23): instead of a pass that resets every edge and another that applies the active incidents, the
    // active ones are folded per edge here, in the same order and from the same 1.0, and the edge loop below resets
    // and applies them as it reaches each edge. One pass over the edges fewer, and every value the same.
    struct IncidentNow { std::uint32_t edge; double speed, capacity; bool closed; };
    std::vector<IncidentNow> incidents_now;
    const bool fused = sc.edges.size() == edge_states.size();
    if (sc.config.incidents) {
        for (const auto& inc : sc.incidents) {
            if (ctx.virtual_s >= inc.start_virtual_s && ctx.virtual_s < inc.end_virtual_s && inc.edge.value < edge_states.size()) {
                auto found = std::find_if(incidents_now.begin(), incidents_now.end(), [&](const IncidentNow& n) { return n.edge == inc.edge.value; });
                if (found == incidents_now.end()) found = incidents_now.insert(incidents_now.end(), {inc.edge.value, 1.0, 1.0, false});
                found->speed = std::min(found->speed, inc.speed_multiplier);
                found->capacity = std::min(found->capacity, inc.capacity_multiplier);
                if (inc.closed) found->closed = true;
            }
        }
        std::sort(incidents_now.begin(), incidents_now.end(), [](const IncidentNow& x, const IncidentNow& y) { return x.edge < y.edge; });
    }
    const auto apply_incidents = [&](std::uint32_t edge, EdgeDynamic& es) {
        es.incident_speed_multiplier = 1.0;
        es.incident_capacity_multiplier = 1.0;
        es.incident_closed = false;
        const auto found = std::lower_bound(incidents_now.begin(), incidents_now.end(), edge, [](const IncidentNow& n, std::uint32_t id) { return n.edge < id; });
        if (found != incidents_now.end() && found->edge == edge) {
            es.incident_speed_multiplier = found->speed;
            es.incident_capacity_multiplier = found->capacity;
            es.incident_closed = found->closed;
        }
    };
    if (!fused)
        for (std::uint32_t i = 0; i < edge_states.size(); ++i) apply_incidents(i, edge_states[i]);

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

    // Signals (#23): each node's phase read once, and each edge's group from a compact table, instead of a lookup
    // through the controllers per edge. signal_value gives exactly what signal_multiplier would.
    const auto* signal_groups = sc.config.signals ? ctx.events.edge_signal_groups() : nullptr;
    static thread_local std::vector<std::uint32_t> signal_phases;
    if (signal_groups) ctx.events.signal_phases(signal_phases);
    // A junction set by hand is rare: no lookup per edge when there is none (#23).
    const bool has_overrides = sc.config.signals && !ctx.signal_overrides.empty();
    // Each edge stamped with the revision commit is about to give it, as the loop reaches it (#23).
    const auto revision = ctx.graph.state_revision() + 1;

    double congestion_sum = 0, congestion_weights = 0;
    // What recouple scans the edges for, noted here as each edge is done (#23).
    const bool coupling = fused && ctx.events.coupling(sc);
    bool network_changed = false, disturbed = false;
    const auto note = [&](std::uint32_t edge, const EdgeDynamic& d) {
        if (!coupling) return;
        if (ctx.events.note_edge(edge, d)) network_changed = true;
        if (d.rainfall != 0 || d.flood != 0 || d.closed || d.incident_closed) {
            disturbed = true;
            ctx.events.note_disturbed(edge);
        }
    };
    const auto& rows = edge_rows(ctx.graph);
    for (std::size_t at = 0; at < rows.size(); ++at) {
        const auto& r = rows[at];
        auto& es = edge_states[r.id];
        if (fused) {
            apply_incidents(r.id, es);
            es.state_revision = revision;
        }
        const auto& na = node_states[r.from];
        const auto& nb = node_states[r.to];
        es.rainfall = (na.rainfall + nb.rainfall) / 2;
        const bool was_flooded=es.flood>.01;
        es.flood = (na.flood + nb.flood) / 2;
        if(r.allowed && was_flooded!=(es.flood>.01)){
            ctx.events.observe({ctx.virtual_s,r.id,0,0,"flooding",es.flood>.01?"Road becomes flood affected":"Flood effect cleared",es.flood});
            if(es.flood>.01 && r.id%2==0) ctx.add_news(800000+r.id,"flooding","warning","FLOOD_STARTED","Flooding detected on Edge "+std::to_string(r.id),{{"edge_id",r.id},{"flood",es.flood}});
        }
        if (!r.allowed) {
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
            note(r.id, es);
            continue;
        }
        const auto attraction = sc.config.buildings ? ctx.events.demand_effect(EdgeId{r.id}) : 0.0;
        const auto hot = sc.config.traffic ? r.hotspot : 0;
        
        // Active Surge Multiplier following a smooth Gaussian / Normal Distribution curve
        double surge_mult = 1.0;
        for (const auto& s : surges) {
            const double d1 = point_distance(sc.nodes[r.from].position, s.centre);
            const double d2 = point_distance(sc.nodes[r.to].position, s.centre);
            if (d1 <= s.radius_m || d2 <= s.radius_m) {
                surge_mult = std::max(surge_mult, s.factor);
            }
        }

        es.demand_vph = sc.config.traffic ? r.base_capacity_vph * (.18 + .68 * day_profile + .60 * attraction + .35 * hot) * surge_mult : 0;
        
        es.signal_multiplier = signal_groups ? EventRuntime::signal_value((*signal_groups)[r.id], signal_phases[r.to]) : 1.0;
        if (has_overrides && ctx.signal_overrides.contains(r.to)) {
            const auto& a=sc.nodes[r.from].position;const auto& b=sc.nodes[r.to].position;
            bool ns=std::abs(b.y_m-a.y_m)>=std::abs(b.x_m-a.x_m);
            es.signal_multiplier=(ns==(ctx.signal_overrides.at(r.to)==1))?1.0:.08;
        }

        // Realistic Weather Sensitivity (Rain causes moderate 10-25% slowing rather than sudden impassability)
        es.rain_speed_multiplier = 1.0 - 0.18 * es.rainfall;
        es.flood_speed_multiplier = std::max(0.35, 1.0 - 0.55 * es.flood);
        es.rain_capacity_multiplier = 1.0 - 0.15 * es.rainfall;
        es.flood_capacity_multiplier = std::max(0.30, 1.0 - 0.60 * es.flood);

        // Smooth speed deceleration and acceleration curves (realistic gradual vehicle movement)
        const bool is_closed = es.manual_closed || es.incident_closed || es.flood >= 0.98;
        const double target_speed = is_closed ? 0.0 : (r.free_speed_mps * es.signal_multiplier * es.rain_speed_multiplier * es.flood_speed_multiplier * es.manual_speed_multiplier * es.incident_speed_multiplier);
        // Both ways worked out and one chosen, rather than a branch the signals make unpredictable (#23): the same
        // arithmetic, so the same values.
        {
            const double speed = es.effective_speed_mps;
            const double up = std::min(target_speed, speed + 2.4 * dt);
            const double down = std::max(target_speed, speed - 3.2 * dt);
            es.effective_speed_mps = speed < target_speed ? up : (speed > target_speed ? down : speed);
        }

        es.effective_capacity_vph = r.base_capacity_vph * es.signal_multiplier * es.rain_capacity_multiplier * es.flood_capacity_multiplier * es.manual_capacity_multiplier * es.incident_capacity_multiplier;
        es.closed = is_closed;

        // Smooth physical vehicle queuing dynamics (eliminates abrupt 51 -> 2 jumps)
        const double baseline_veh = (es.demand_vph / r.speed_floor_kmh) * r.length_km;
        const double max_queue_veh = r.max_queue_veh;
        const double target_veh = es.closed ? 0.0 : std::clamp(baseline_veh * (1.0 + 3.5 * (1.0 - es.signal_multiplier) * (0.5 + 0.5 * surge_mult)), 0.0, max_queue_veh);

        const double current_veh = es.vehicle_load;
        const double rate_factor = 1.0;
        // Queue buildup accumulates smoothly at the physical inflow rate; discharge drains at the saturation flow
        // rate. Both worked out, one chosen, as for the speed above.
        const double max_inflow_step = std::max(0.4, (es.demand_vph / 3600.0) * dt * rate_factor);
        const double max_discharge_step = std::max(0.7, r.discharge_lanes * dt * rate_factor);
        const double filled = std::min(target_veh, current_veh + max_inflow_step);
        const double drained = std::max(target_veh, current_veh - max_discharge_step);
        const double next_veh = target_veh > current_veh ? filled : (target_veh < current_veh ? drained : current_veh);

        es.vehicle_load=next_veh;
        es.vehicle_count = static_cast<std::uint32_t>(std::llround(next_veh));
        es.congestion_model = clamp01(double(es.vehicle_count) / r.congestion_room);
        es.mean_speed_mps = es.effective_speed_mps * (1.0 - es.congestion_model * 0.65);
        es.halting_count = static_cast<std::uint32_t>(std::llround(es.vehicle_count * (1.0 - es.signal_multiplier * 0.9)));
        es.occupancy = clamp01(es.vehicle_count * 5.0 / r.occupancy_room);
        es.congestion_observed = 1.0 - (1.0 - clamp01(1.0 - es.mean_speed_mps / std::max(0.1, es.effective_speed_mps))) * (1.0 - double(es.halting_count) / std::max(1u, es.vehicle_count)) * (1.0 - es.occupancy);
        const double speed_loss = es.vehicle_count ? clamp01(1.0-es.mean_speed_mps/r.free_speed_floor) : 0.0;
        const double queue_ratio = double(es.halting_count)/std::max(1u,es.vehicle_count);
        es.congestion = es.closed ? 1.0 : clamp01(.60*speed_loss+.25*queue_ratio+.15*es.occupancy);
        // The district's congestion, summed here in the edges' order, as CongestionTracker::update would (#23).
        const double weight = r.weight;
        congestion_sum += weight * es.congestion;
        congestion_weights += weight;
        note(r.id, es);
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

    ctx.congestion.record(congestion_sum, congestion_weights, ctx.virtual_s, dt);
    // Places respond to the conditions this tick produced: roads shut, rain
    // falling, an incident nearby. Run last, so couplings read the same state
    // the operator is about to be shown rather than the previous tick's.
    if (coupling) ctx.events.recouple_noted(sc, ctx.graph.edge_states(), ctx.virtual_s, network_changed, disturbed);
    else ctx.events.recouple(sc, ctx.graph.edge_states(), ctx.virtual_s);
    if (fused) ctx.graph.commit_stamped();
    else ctx.graph.commit();
}

} // namespace dstns::core_ng
