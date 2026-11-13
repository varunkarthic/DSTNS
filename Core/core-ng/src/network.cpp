// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic
// Ported from core-legacy's ScenarioCompiler with every expression unchanged, so results are identical to the
// last bit: the golden fixtures check it on both engines.

#include "dstns/core-ng/compile.hpp"
#include "dstns/geo.hpp"
#include "dstns/graph.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <queue>

namespace dstns::core_ng::plan {
namespace {
RoadClass road_class(std::uint32_t x, std::uint32_t y) {
    if (x % 5 == 0)
        return RoadClass::Primary;
    if (y % 4 == 0)
        return RoadClass::Secondary;
    if ((x + y) % 3 == 0)
        return RoadClass::Tertiary;
    return RoadClass::Residential;
}
double speed(RoadClass c) {
    switch (c) {
    case RoadClass::Motorway:
        return 30.0;
    case RoadClass::Primary:
        return 16.67;
    case RoadClass::Secondary:
        return 13.89;
    case RoadClass::Tertiary:
        return 11.11;
    case RoadClass::Residential:
        return 8.33;
    case RoadClass::Service:
        return 5.56;
    }
    return 8.33;
}
double capacity(RoadClass c) {
    switch (c) {
    case RoadClass::Motorway:
        return 4800;
    case RoadClass::Primary:
        return 3200;
    case RoadClass::Secondary:
        return 2400;
    case RoadClass::Tertiary:
        return 1800;
    case RoadClass::Residential:
        return 1100;
    case RoadClass::Service:
        return 600;
    }
    return 1100;
}
} // namespace

void grid(Scenario &s, const DeterministicRng &rng) {
    const auto w = s.config.grid_width, h = s.config.grid_height;
    const double spacing = 180.0;
    // Map seed mixing selects metropolitan transport region from global catalog
    // The same world catalogue the downloaded maps are drawn from, so a
    // synthetic grid sits where its seed says it does.
    const auto &catalog = city_catalog();
    const auto city_idx = rng.bounded({RngDomain::MapSelection, 0, 0, 0}, static_cast<std::uint32_t>(catalog.size()));
    const auto &city = catalog[city_idx];
    const auto lat0 = city.lat + (rng.uniform01({RngDomain::MapSelection, 0, 1, 0}) - 0.5) * 0.04;
    const auto lon0 = city.lon + (rng.uniform01({RngDomain::MapSelection, 0, 2, 0}) - 0.5) * 0.04;
    s.nodes.reserve(std::size_t(w) * h);
    for (std::uint32_t y = 0; y < h; ++y)
        for (std::uint32_t x = 0; x < w; ++x) {
            const auto id = y * w + x;
            NodeStatic n;
            n.id = {id};
            n.osm_node_id = 9'000'000'000LL + id;
            const double lat_deg = lat0 + y * spacing / 111320.0;
            const double lon_deg = lon0 + x * spacing / (111320.0 * std::cos(lat0 * 3.141592653589793 / 180.0));
            n.position = {x * spacing, y * spacing, lat_deg, lon_deg};
            n.flood_susceptibility = .2 + .75 * rng.uniform01({RngDomain::DwsField, id, 1, 0});
            n.drainage = .2 + .7 * rng.uniform01({RngDomain::DwsField, id, 2, 0});
            s.nodes.push_back(n);
        }
    auto add = [&](NodeId a, NodeId b, RoadClass cls, std::uint32_t segment) {
        const auto first = static_cast<std::uint32_t>(s.edges.size());
        const auto length = point_distance(s.nodes[a.value].position, s.nodes[b.value].position);
        for (int direction = 0; direction < 2; ++direction) {
            EdgeStatic e;
            e.id = {static_cast<std::uint32_t>(s.edges.size())};
            e.from = direction ? a : b;
            e.to = direction ? b : a;
            e.reverse_twin = {first + std::uint32_t(1 - direction)};
            e.osm_way_id = 8'000'000'000LL + segment;
            e.segment_index = 0;
            e.road_class = cls;
            e.source_oneway = false;
            e.synthetic_reverse = false;
            e.lanes = cls == RoadClass::Primary ? 2 : 1;
            e.length_m = length;
            e.free_speed_mps = speed(cls);
            e.base_capacity_vph = capacity(cls);
            e.flood_susceptibility =
                (s.nodes[a.value].flood_susceptibility + s.nodes[b.value].flood_susceptibility) / 2;
            e.geometry = {s.nodes[e.from.value].position, s.nodes[e.to.value].position};
            s.edges.push_back(e);
        }
        s.nodes[a.value].degree++;
        s.nodes[b.value].degree++;
    };
    std::uint32_t seg = 0;
    for (std::uint32_t y = 0; y < h; ++y)
        for (std::uint32_t x = 0; x < w; ++x) {
            const NodeId here{y * w + x};
            if (x + 1 < w)
                add(here, {y * w + x + 1}, road_class(x, y), seg++);
            if (y + 1 < h)
                add(here, {(y + 1) * w + x}, road_class(x, y), seg++);
        }
    s.root = {static_cast<std::uint32_t>((h / 2) * w + w / 2)};
}

void bus_stops(Scenario &s) {
    const auto n = s.nodes.size();
    std::vector<std::vector<std::pair<NodeId, double>>> adj(n);
    for (std::size_t i = 0; i < s.edges.size(); i += 2) {
        const auto &e = s.edges[i];
        adj[e.from.value].push_back({e.to, e.length_m});
        adj[e.to.value].push_back({e.from, e.length_m});
    }
    std::vector<int> shell(n, -1);
    std::queue<NodeId> q;
    shell[s.root.value] = 0;
    q.push(s.root);
    while (!q.empty()) {
        auto u = q.front();
        q.pop();
        std::sort(adj[u.value].begin(), adj[u.value].end(),
                  [](auto a, auto b) { return a.first.value < b.first.value; });
        for (auto [v, d] : adj[u.value]) {
            (void)d;
            if (shell[v.value] < 0) {
                shell[v.value] = shell[u.value] + 1;
                q.push(v);
            }
        }
    }
    std::vector<NodeId> order(n);
    for (std::size_t i = 0; i < n; ++i)
        order[i] = NodeId{static_cast<std::uint32_t>(i)};
    std::sort(order.begin(), order.end(), [&](auto a, auto b) {
        if (shell[a.value] != shell[b.value])
            return shell[a.value] < shell[b.value];
        if (s.nodes[a.value].degree != s.nodes[b.value].degree)
            return s.nodes[a.value].degree > s.nodes[b.value].degree;
        return a.value < b.value;
    });
    auto graph_dist = [&](NodeId start, const std::vector<BusStop> &stops, double cutoff) {
        std::vector<double> d(n, 1e100);
        using P = std::pair<double, NodeId>;
        struct C {
            bool operator()(const P &a, const P &b) const {
                return a.first > b.first || (a.first == b.first && a.second.value > b.second.value);
            }
        };
        std::priority_queue<P, std::vector<P>, C> pq;
        d[start.value] = 0;
        pq.push({0, start});
        while (!pq.empty()) {
            auto [du, u] = pq.top();
            pq.pop();
            if (du != d[u.value] || du > cutoff)
                continue;
            for (const auto &st : stops)
                if (u == st.anchor_node)
                    return du;
            for (auto [v, w] : adj[u.value])
                if (du + w < d[v.value]) {
                    d[v.value] = du + w;
                    pq.push({d[v.value], v});
                }
        }
        return 1e100;
    };
    auto outgoing_edge = [&](NodeId node) {
        return std::find_if(s.edges.begin(), s.edges.end(),
                            [&](const auto &e) { return e.from == node && is_source_direction_allowed(e); });
    };
    for (auto candidate : order) {
        if (s.nodes[candidate.value].degree < 2)
            continue;
        const auto nearest =
            s.bus_stops.empty() ? 1e100 : graph_dist(candidate, s.bus_stops, s.config.stop_min_spacing_m);
        if (s.bus_stops.empty() || nearest >= s.config.stop_min_spacing_m) {
            auto it = outgoing_edge(candidate);
            if (it != s.edges.end()) {
                BusStop stop;
                stop.id = {static_cast<std::uint32_t>(s.bus_stops.size())};
                stop.anchor_node = candidate;
                stop.edge = it->id;
                stop.position_m = std::min(15.0, it->length_m * .25);
                stop.nearest_stop_distance_m = s.bus_stops.empty() ? 0 : nearest;
                s.bus_stops.push_back(stop);
                s.nodes[candidate.value].bus_stop = true;
            }
        }
    }
    // Coverage repair: deterministically add the farthest eligible node until all are within max coverage.
    for (;;) {
        double farthest = -1;
        NodeId pick{};
        auto pick_edge = s.edges.end();
        for (const auto &node : s.nodes) {
            if (node.degree < 2 || node.bus_stop)
                continue;
            const auto edge = outgoing_edge(node.id);
            if (edge == s.edges.end())
                continue;
            const auto d = graph_dist(node.id, s.bus_stops, 1e9);
            if (d > farthest || (d == farthest && node.id.value < pick.value)) {
                farthest = d;
                pick = node.id;
                pick_edge = edge;
            }
        }
        if (farthest <= s.config.stop_max_coverage_m || farthest < 0 || pick_edge == s.edges.end())
            break;
        BusStop stop{{static_cast<std::uint32_t>(s.bus_stops.size())},
                     pick,
                     pick_edge->id,
                     std::min(15.0, pick_edge->length_m * .25),
                     farthest};
        s.bus_stops.push_back(stop);
        s.nodes[pick.value].bus_stop = true;
    }
}

void buildings(Scenario &s, const DeterministicRng &rng) {
    const std::array<BuildingType, 4> types{BuildingType::School, BuildingType::Office, BuildingType::Mall,
                                            BuildingType::Store};
    for (const auto &stop : s.bus_stops) {
        if (rng.uniform01({RngDomain::Buildings, stop.id.value, 0, 0}) > .72)
            continue;
        std::vector<NodeId> candidates;
        for (const auto &n : s.nodes) {
            const auto d = point_distance(n.position, s.nodes[stop.anchor_node.value].position);
            if (d >= 80 && d <= 250 && !n.bus_stop && !n.building)
                candidates.push_back(n.id);
        }
        if (candidates.empty())
            continue;
        std::sort(candidates.begin(), candidates.end(), [](auto a, auto b) { return a.value < b.value; });
        auto chosen = candidates[rng.bounded({RngDomain::Buildings, stop.id.value, 1, 0},
                                             static_cast<std::uint32_t>(candidates.size()))];
        auto &n = s.nodes[chosen.value];
        n.building = types[rng.bounded({RngDomain::Buildings, stop.id.value, 2, 0}, 4)];
        const auto u = rng.uniform01({RngDomain::Buildings, stop.id.value, 3, 0});
        n.building_impact = .25 + .6 * u;
        n.building_radius_m = 180 + 520 * rng.uniform01({RngDomain::Buildings, stop.id.value, 4, 0});
        switch (*n.building) {
        case BuildingType::School:
            n.tmax = {{291667, 375000, 3, 3}, {625000, 687500, 3, 3}};
            break;
        case BuildingType::Office:
            n.tmax = {{312500, 416667, 2, 3}, {687500, 812500, 3, 2}};
            break;
        case BuildingType::Mall:
            n.tmax = {{437500, 937500, 1, 1}};
            break;
        case BuildingType::Store:
            n.tmax = {{354167, 895833, 1, 1}};
            break;
        }
    }
}

} // namespace dstns::core_ng::plan
