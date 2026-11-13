// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic
// Ported from core-legacy's ScenarioCompiler with every expression unchanged, so results are identical to the
// last bit: the golden fixtures check it on both engines.

#include "dstns/core-ng/compile.hpp"
#include "dstns/graph.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <sstream>

namespace dstns::core_ng::plan {
namespace {
constexpr std::uint32_t ppm_day = 1'000'000, seconds_day = 86'400;
// A signal controller belongs where at least three ways meet. Below that the
// OSM tag denotes a crossing or a gate, not an intersection.
constexpr std::uint32_t kMinimumSignalDegree = 3;

// How far a tagged stop line may sit from the junction it governs. Approach
// stop lines are typically within a few car lengths of the intersection.
constexpr double kSignalSnapRadiusM = 45.0;
std::string canonical_graph(const Scenario &s) {
    std::ostringstream o;
    for (const auto &n : s.nodes)
        o << n.id.value << ',' << n.osm_node_id << ',' << std::llround(n.position.x_m * 1000) << ','
          << std::llround(n.position.y_m * 1000) << ';';
    for (const auto &e : s.edges)
        o << e.id.value << ',' << e.from.value << ',' << e.to.value << ',' << e.reverse_twin.value << ','
          << std::llround(e.length_m * 1000) << ',' << e.synthetic_reverse << ';';
    return o.str();
}
} // namespace

void signals(Scenario &s) {
    DeterministicRng rng(s.seed.derive("signals"));
    // Approach capacity per axis: [0] = north-south, [1] = east-west. Green time
    // is split between the two opposing groups in proportion to what arrives.
    std::vector<std::array<double, 2>> demand(s.nodes.size(), {1.0, 1.0});
    for (const auto &e : s.edges)
        if (is_source_direction_allowed(e)) {
            const auto &a = s.nodes[e.from.value].position;
            const auto &b = s.nodes[e.to.value].position;
            demand[e.to.value][std::abs(b.y_m - a.y_m) >= std::abs(b.x_m - a.x_m) ? 0 : 1] += e.base_capacity_vph;
        }

    // Place controllers at intersections, not mid-block.
    //
    // OpenStreetMap almost never tags `highway=traffic_signals` on the shared
    // junction node: it tags the stop-line node a few metres back along one
    // approach, which in this graph has degree 2. Taking the tags literally
    // scatters signals along straight roads; discarding everything below degree
    // three deletes all of them. So each tagged node is snapped to the nearest
    // real junction within kSignalSnapRadiusM, and several approaches to one
    // junction collapse to the single controller that governs it.
    std::vector<NodeId> junctions;
    for (const auto &n : s.nodes)
        if (n.degree >= kMinimumSignalDegree)
            junctions.push_back(n.id);

    // Bucket junctions so snapping stays linear in the number of tagged nodes.
    std::map<std::pair<int, int>, std::vector<NodeId>> junction_cells;
    const double cell = kSignalSnapRadiusM;
    for (const auto id : junctions) {
        const auto &p = s.nodes[id.value].position;
        junction_cells[{int(std::floor(p.x_m / cell)), int(std::floor(p.y_m / cell))}].push_back(id);
    }

    std::vector<bool> controls(s.nodes.size(), false);
    const auto snap = [&](const NodeStatic &tagged) {
        const auto &p = tagged.position;
        const int cx = int(std::floor(p.x_m / cell)), cy = int(std::floor(p.y_m / cell));
        double best = kSignalSnapRadiusM * kSignalSnapRadiusM;
        NodeId chosen{};
        bool found = false;
        for (int dx = -1; dx <= 1; ++dx)
            for (int dy = -1; dy <= 1; ++dy) {
                const auto it = junction_cells.find({cx + dx, cy + dy});
                if (it == junction_cells.end())
                    continue;
                for (const auto id : it->second) {
                    const auto &q = s.nodes[id.value].position;
                    const double d = (q.x_m - p.x_m) * (q.x_m - p.x_m) + (q.y_m - p.y_m) * (q.y_m - p.y_m);
                    // Ties resolve by id so the choice never depends on iteration order.
                    if (d < best || (d == best && found && id.value < chosen.value)) {
                        best = d;
                        chosen = id;
                        found = true;
                    }
                }
            }
        return std::pair{found, chosen};
    };

    for (const auto &n : s.nodes) {
        const bool synthetic = s.config.osm_file.empty() && n.degree >= 4 && n.id.value % 3 == 0;
        if (synthetic) {
            controls[n.id.value] = true;
            continue;
        }
        if (!n.signal)
            continue;
        if (n.degree >= kMinimumSignalDegree) {
            controls[n.id.value] = true;
            continue;
        }
        const auto [found, at] = snap(n);
        // A tagged node with no junction nearby is a pedestrian crossing or a
        // gated driveway. Those are real, but they are not intersections.
        if (found)
            controls[at.value] = true;
    }
    for (auto &n : s.nodes)
        n.signal = controls[n.id.value];

    // Offsets form a progression outward from the centre of the signalised area
    // rather than being drawn at random. Signals a block apart then turn green in sequence - the
    // "green wave" a real corridor is timed for - instead of flickering
    // independently. The reference speed is a nominal 50 km/h arterial.
    constexpr double kProgressionSpeedMps = 13.9;
    double origin_x = 0, origin_y = 0;
    std::size_t controllers = 0;
    for (const auto &n : s.nodes)
        if (n.signal) {
            origin_x += n.position.x_m;
            origin_y += n.position.y_m;
            ++controllers;
        }
    if (controllers) {
        origin_x /= double(controllers);
        origin_y /= double(controllers);
    }

    for (auto &n : s.nodes)
        if (n.signal) {
            const auto id = static_cast<std::uint64_t>(n.osm_node_id);
            const double total = demand[n.id.value][0] + demand[n.id.value][1];
            const auto cycle = std::uint16_t(std::clamp(45.0 + 4.0 * n.degree + total / 1200.0 +
                                                            20.0 * rng.uniform01({RngDomain::TrafficSignals, id, 0, 0}),
                                                        50.0, 120.0));
            const auto green =
                std::uint16_t(std::clamp(double(cycle - 8) * demand[n.id.value][0] / total, 12.0, double(cycle - 20)));
            const auto other = std::uint16_t(cycle - 8 - green);
            n.signal_cycle_s = cycle;
            n.signal_green_s = green;
            // Travel time from the network's centre to this junction, wrapped into
            // the cycle. Neighbouring junctions differ by the time it takes to drive
            // between them, so a platoon released at one arrives at the next on green.
            const double distance = std::hypot(n.position.x_m - origin_x, n.position.y_m - origin_y);
            const double travel = distance / kProgressionSpeedMps;
            n.signal_offset_s = std::uint16_t(std::llround(std::fmod(travel, double(cycle))));
            s.signals.push_back({n.id, cycle, {green, 3, 1, other, 3, 1}, n.signal_offset_s});
        }
}
void hotspots(Scenario &s, const DeterministicRng &rng) {
    std::vector<std::pair<double, EdgeId>> scores;
    for (auto &e : s.edges) {
        if (!is_source_direction_allowed(e))
            continue;
        const auto central = (s.nodes[e.from.value].degree + s.nodes[e.to.value].degree) / 8.0;
        const auto score = central * (.5 + .5 * rng.uniform01({RngDomain::TrafficControl, e.id.value, 1, 0}));
        scores.push_back({score, e.id});
    }
    const auto count = std::min<std::size_t>(std::clamp<std::size_t>(s.edges.size() / 80, 1, 24), scores.size());
    std::sort(scores.begin(), scores.end(),
              [](auto a, auto b) { return a.first != b.first ? a.first > b.first : a.second.value < b.second.value; });
    for (std::size_t i = 0; i < count; ++i) {
        s.hotspot_edges.push_back(scores[i].second);
        s.edges[scores[i].second.value].hotspot_susceptibility =
            .5 + .5 * rng.uniform01({RngDomain::TrafficControl, scores[i].second.value, 2, 0});
    }
}
void trips(Scenario &s, const DeterministicRng &rng) {
    GraphStore g(s);
    RoutePlanner router(g);
    std::uint64_t id = 0;
    for (std::uint32_t bin = 0; bin < seconds_day / s.config.demand_bin_virtual_s; ++bin) {
        const auto base = 2 + rng.bounded({RngDomain::TrafficOD, bin, 0, 0}, 5);
        for (std::uint32_t j = 0; j < base; ++j) {
            auto from =
                NodeId{rng.bounded({RngDomain::TrafficOD, bin, 1, j}, static_cast<std::uint32_t>(s.nodes.size()))};
            auto to =
                NodeId{rng.bounded({RngDomain::TrafficOD, bin, 2, j}, static_cast<std::uint32_t>(s.nodes.size()))};
            if (from == to)
                to.value = (to.value + 1) % s.nodes.size();
            auto route = router.route(from, to);
            if (route.found)
                s.trips.push_back({id++,
                                   bin * s.config.demand_bin_virtual_s +
                                       rng.bounded({RngDomain::TrafficOD, bin, 3, j}, s.config.demand_bin_virtual_s),
                                   from, to, std::move(route.edges)});
        }
    }
    std::sort(s.trips.begin(), s.trips.end(), [](auto &a, auto &b) {
        return a.depart_virtual_s != b.depart_virtual_s ? a.depart_virtual_s < b.depart_virtual_s : a.id < b.id;
    });
}
void weather(Scenario &s, const DeterministicRng &rng) {
    const auto f = s.config.dws_frequency;
    if (!f)
        return;
    std::vector<double> u(f);
    for (std::uint32_t i = 0; i < f; ++i)
        u[i] = rng.uniform01({RngDomain::DwsSchedule, i, 0, 0});
    std::stable_sort(u.begin(), u.end());
    const auto slack = double(s.config.playback_duration_s - 5 * (f - 1));
    for (std::uint32_t i = 0; i < f; ++i) {
        const auto playback = 5 * i + slack * u[i];
        const auto start = std::uint32_t(std::llround(playback / s.config.playback_duration_s * ppm_day));
        const auto duration = std::uint32_t(
            (45 + 75 * std::pow(rng.uniform01({RngDomain::DwsSchedule, i, 1, 0}), 1.5)) / 1440.0 * ppm_day);
        DwsEvent e;
        e.id = {i + 1};
        e.epicenter = {rng.bounded({RngDomain::DwsSchedule, i, 2, 0}, static_cast<std::uint32_t>(s.nodes.size()))};
        e.start_ppm = start;
        e.end_ppm = std::min(ppm_day, start + duration);
        e.intensity = .15 + .85 * std::pow(rng.uniform01({RngDomain::DwsSchedule, i, 3, 0}), 1.7);
        const auto rmin = 100.0, rmax = 600.0;
        e.radius_m = rmin + (rmax - rmin) * rng.uniform01({RngDomain::DwsSchedule, i, 4, 0});
        e.flood_gain = .35 + .6 * rng.uniform01({RngDomain::DwsSchedule, i, 5, 0});
        e.recovery = .08 + .15 * rng.uniform01({RngDomain::DwsSchedule, i, 6, 0});
        s.dws_events.push_back(e);
    }
}
void incidents(Scenario &s, const DeterministicRng &rng) {
    if (s.edges.empty() || s.nodes.empty())
        return;
    std::vector<EdgeId> eligible_edges;
    for (const auto &e : s.edges) {
        if (is_source_direction_allowed(e))
            eligible_edges.push_back(e.id);
    }
    if (eligible_edges.empty())
        return;

    const std::uint32_t count = std::max<std::uint32_t>(
        s.config.min_incidents, std::max(4u, static_cast<std::uint32_t>(s.config.playback_duration_s / 600)));
    s.incidents.reserve(count);
    const std::uint32_t day_span = seconds_day;

    for (std::uint32_t i = 0; i < count; ++i) {
        double slot_min = 0.08, slot_max = 0.92;
        if (count >= 3) {
            if (i % 3 == 0) {
                slot_min = 0.08;
                slot_max = 0.35;
            } else if (i % 3 == 1) {
                slot_min = 0.35;
                slot_max = 0.65;
            } else {
                slot_min = 0.65;
                slot_max = 0.92;
            }
        }
        const double frac = slot_min + (slot_max - slot_min) * rng.uniform01({RngDomain::Incidents, i, 0, 0});
        const std::uint32_t start_s = static_cast<std::uint32_t>(frac * day_span);
        const std::uint32_t dur_s = 900 + rng.bounded({RngDomain::Incidents, i, 1, 0}, 1801);
        const std::uint32_t end_s = std::min(day_span, start_s + dur_s);

        const auto edge_idx =
            rng.bounded({RngDomain::Incidents, i, 2, 0}, static_cast<std::uint32_t>(eligible_edges.size()));
        const auto edge_id = eligible_edges[edge_idx];
        const auto &edge = s.edges[edge_id.value];
        const auto node_id = edge.from;
        const auto type = static_cast<IncidentType>(rng.bounded({RngDomain::Incidents, i, 3, 0}, 5));

        Incident inc;
        inc.id = i + 1;
        inc.type = type;
        inc.edge = edge_id;
        inc.node = node_id;
        inc.start_virtual_s = start_s;
        inc.end_virtual_s = end_s;

        switch (type) {
        case IncidentType::RoadClosure:
            inc.speed_multiplier = 0.0;
            inc.capacity_multiplier = 0.0;
            inc.closed = true;
            inc.description = "Emergency road closure: through-traffic prohibited on corridor";
            break;
        case IncidentType::Accident:
            inc.speed_multiplier = 0.35;
            inc.capacity_multiplier = 0.40;
            inc.closed = false;
            inc.description = "Multi-vehicle collision: lane blocked, emergency services on scene";
            break;
        case IncidentType::Congestion:
            inc.speed_multiplier = 0.45;
            inc.capacity_multiplier = 0.50;
            inc.closed = false;
            inc.description = "Severe localized congestion bottleneck with bumper-to-bumper queue";
            break;
        case IncidentType::VehicleBreakdown:
            inc.speed_multiplier = 0.55;
            inc.capacity_multiplier = 0.60;
            inc.closed = false;
            inc.description = "Commercial transit vehicle breakdown obstructing right lane";
            break;
        case IncidentType::HazardSpill:
            inc.speed_multiplier = 0.20;
            inc.capacity_multiplier = 0.25;
            inc.closed = false;
            inc.description = "Hazardous cargo spill: hazardous pavement conditions, severe speed reduction";
            break;
        }
        s.incidents.push_back(std::move(inc));
    }

    std::sort(s.incidents.begin(), s.incidents.end(), [](const Incident &a, const Incident &b) {
        if (a.start_virtual_s != b.start_virtual_s)
            return a.start_virtual_s < b.start_virtual_s;
        return a.id < b.id;
    });
}
void hashes(Scenario &s) {
    const auto graph = canonical_graph(s);
    s.graph_hash = "sha256:" + sha256(graph);
    std::ostringstream ev;
    ev << "events-v2/" << s.config.map_selection_version;
    for (const auto &p : s.signals) {
        ev << p.node.value << ',' << p.cycle_s << ',' << p.offset_s;
        for (auto phase : p.phases_s)
            ev << ',' << phase;
    }
    for (const auto &f : s.features)
        if (f.demand_type)
            ev << f.id << ',' << static_cast<int>(*f.demand_type);
    for (const auto &e : s.dws_events)
        ev << e.id.value << ',' << e.epicenter.value << ',' << e.start_ppm << ',' << e.end_ppm << ','
           << std::llround(e.intensity * 1e6) << ';';
    for (const auto &t : s.trips)
        ev << t.id << ',' << t.depart_virtual_s << ',' << t.from.value << ',' << t.to.value << ';';
    for (const auto &inc : s.incidents)
        ev << inc.id << ',' << static_cast<int>(inc.type) << ',' << inc.edge.value << ',' << inc.start_virtual_s << ','
           << inc.end_virtual_s << ';';
    s.event_hash = "sha256:" + sha256(ev.str());
    s.scenario_hash =
        "sha256:" + sha256(s.seed.hex() + s.map_hash + s.graph_hash + s.event_hash + std::to_string(s.config.day));
}

} // namespace dstns::core_ng::plan
