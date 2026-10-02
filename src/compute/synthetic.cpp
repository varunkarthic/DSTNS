// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/compute/synthetic.hpp"

#include <algorithm>
#include <cmath>

namespace dstns::compute {

Scenario synthetic_world(std::uint32_t nodes, std::uint64_t seed) {
    Scenario s;
    s.seed = {seed, seed ^ 0x9E3779B97F4A7C15ull};
    const DeterministicRng rng(s.seed);
    auto draw = [&](std::uint64_t object, std::uint32_t purpose) {
        return rng.uniform01({RngDomain::TrafficControl, object, purpose, 0});
    };
    const auto width = std::max<std::uint32_t>(1, static_cast<std::uint32_t>(std::lround(std::sqrt(double(std::max<std::uint32_t>(nodes, 1))))));
    const auto height = std::max<std::uint32_t>(1, (std::max<std::uint32_t>(nodes, 1) + width - 1) / width);
    constexpr double spacing = 120.0;
    for (std::uint32_t y = 0; y < height; ++y)
        for (std::uint32_t x = 0; x < width; ++x) {
            const auto id = static_cast<std::uint32_t>(s.nodes.size());
            if (id >= nodes) break;
            NodeStatic n;
            n.id = {id};
            // A little jitter, so that distances are not all equal.
            n.position.x_m = x * spacing + 20 * (draw(id, 1) - 0.5);
            n.position.y_m = y * spacing + 20 * (draw(id, 2) - 0.5);
            n.flood_susceptibility = .2 + .75 * draw(id, 3);
            n.drainage = .2 + .7 * draw(id, 4);
            s.nodes.push_back(n);
        }
    const auto count = static_cast<std::uint32_t>(s.nodes.size());
    auto add = [&](std::uint32_t a, std::uint32_t b, bool synthetic) {
        EdgeStatic e;
        e.id = {static_cast<std::uint32_t>(s.edges.size())};
        e.from = {a};
        e.to = {b};
        e.synthetic_reverse = synthetic;
        const auto pick = draw(1'000'000 + e.id.value, 1);
        e.road_class = pick < .1 ? RoadClass::Primary : pick < .3 ? RoadClass::Secondary : RoadClass::Residential;
        e.lanes = e.road_class == RoadClass::Primary ? 2 : 1;
        e.free_speed_mps = e.road_class == RoadClass::Primary ? 16.67 : e.road_class == RoadClass::Secondary ? 13.89 : 8.33;
        e.base_capacity_vph = e.road_class == RoadClass::Primary ? 3200 : e.road_class == RoadClass::Secondary ? 2400 : 1100;
        const auto& p = s.nodes[a].position;
        const auto& q = s.nodes[b].position;
        e.length_m = std::hypot(p.x_m - q.x_m, p.y_m - q.y_m);
        if (draw(1'000'000 + e.id.value, 2) < .02) e.hotspot_susceptibility = .5 + .5 * draw(1'000'000 + e.id.value, 3);
        s.edges.push_back(e);
    };
    for (std::uint32_t i = 0; i < count; ++i) {
        const auto x = i % width;
        for (const auto j : {x + 1 < width ? i + 1 : count, i + width}) {
            if (j >= count) continue;
            // One street in nine is one-way: its reverse direction exists in
            // the graph but carries no traffic.
            const bool oneway = draw(i * 2 + (j == i + 1 ? 0 : 1), 5) < 1.0 / 9;
            add(i, j, false);
            add(j, i, oneway);
        }
    }
    for (std::uint32_t i = 0; i < count; ++i) {
        if (i % 7 != 3) continue;
        SignalPlan plan;
        plan.node = {i};
        plan.phases_s = {27, 3, 2, 27, 3, 2};
        plan.cycle_s = 64;
        plan.offset_s = static_cast<std::uint16_t>(i % 64);
        s.signals.push_back(plan);
    }
    for (std::uint32_t k = 0; k < 6 && count; ++k) {
        DwsEvent e;
        e.id = {k + 1};
        e.epicenter = {static_cast<std::uint32_t>(draw(2'000'000 + k, 1) * count) % count};
        e.start_ppm = static_cast<std::uint32_t>(draw(2'000'000 + k, 2) * 800'000);
        e.end_ppm = e.start_ppm + 120'000;
        e.intensity = .3 + .7 * draw(2'000'000 + k, 3);
        e.radius_m = 300 + 900 * draw(2'000'000 + k, 4);
        s.dws_events.push_back(e);
    }
    for (std::uint32_t k = 0; k < 8 && !s.edges.empty(); ++k) {
        Incident inc;
        inc.id = k + 1;
        inc.edge = {static_cast<std::uint32_t>(draw(3'000'000 + k, 1) * s.edges.size()) % static_cast<std::uint32_t>(s.edges.size())};
        inc.start_virtual_s = static_cast<std::uint32_t>(draw(3'000'000 + k, 2) * 80'000);
        inc.end_virtual_s = inc.start_virtual_s + 1800;
        inc.speed_multiplier = k % 2 ? 0.35 : 0.0;
        inc.capacity_multiplier = k % 2 ? 0.40 : 0.0;
        inc.closed = k % 2 == 0;
        s.incidents.push_back(inc);
    }
    return s;
}

} // namespace dstns::compute
