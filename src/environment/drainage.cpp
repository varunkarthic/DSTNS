// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/drainage.hpp"

#include "dstns/environment/hydrology.hpp"
#include "dstns/environment/terrain.hpp"
#include "dstns/graph.hpp"
#include "dstns/model.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <queue>

namespace dstns::env {
namespace {
constexpr double kPi = 3.141592653589793;
constexpr double kGravity = 9.81;
// Metres of extra pipe a metre of adverse rise is worth when laying the network.
constexpr double kAdverseCost = 50.0;
// Standard circular sewer diameters, metres.
constexpr std::array<double, 14> kDiameters{0.30, 0.375, 0.45, 0.525, 0.60, 0.675, 0.75, 0.90, 1.05, 1.20, 1.35, 1.50, 1.80, 2.40};

double full_capacity(double d, double slope, double n) {
    const double area = kPi * d * d / 4, radius = d / 4;
    return area * std::pow(radius, 2.0 / 3.0) * std::sqrt(std::max(slope, 1e-4)) / n;
}

double unit_m3(const DrainageNetwork& net) { return net.cell_area_m2 / kQ24; }
} // namespace

DrainageNetwork build_drainage(const Scenario& s, const Terrain& t, const HydrologyGrid& hg, const DrainageParams& p) {
    DrainageNetwork net;
    net.cell_area_m2 = hg.grid.cell_m * hg.grid.cell_m;
    const auto n = s.nodes.size();
    if (n == 0) return net;
    net.nodes.resize(n);
    const auto& g = hg.grid;
    double lo_x = 1e300, hi_x = -1e300, lo_y = 1e300, hi_y = -1e300;
    for (std::size_t i = 0; i < n; ++i) {
        const auto& pos = s.nodes[i].position;
        auto& d = net.nodes[i];
        d.road_node = static_cast<std::uint32_t>(i);
        auto [u, v] = g.cell_of(pos.x_m, pos.y_m);
        const auto ci = static_cast<std::uint32_t>(std::clamp(u, 0.0, g.width - 1.0));
        const auto cj = static_cast<std::uint32_t>(std::clamp(v, 0.0, g.height - 1.0));
        d.cell = static_cast<std::uint32_t>(g.index(ci, cj));
        d.ground_m = t.elevation_at(pos.x_m, pos.y_m);
        lo_x = std::min(lo_x, pos.x_m);
        hi_x = std::max(hi_x, pos.x_m);
        lo_y = std::min(lo_y, pos.y_m);
        hi_y = std::max(hi_y, pos.y_m);
    }
    // Undirected street adjacency, in id order so every choice is deterministic.
    std::vector<std::vector<std::pair<std::uint32_t, double>>> adj(n);
    for (const auto& e : s.edges) {
        if (e.from.value >= n || e.to.value >= n || e.from.value == e.to.value) continue;
        adj[e.from.value].push_back({e.to.value, e.length_m});
        adj[e.to.value].push_back({e.from.value, e.length_m});
    }
    for (auto& a : adj) {
        std::sort(a.begin(), a.end());
        a.erase(std::unique(a.begin(), a.end(), [](const auto& x, const auto& y) { return x.first == y.first; }), a.end());
    }

    // Outfalls: junctions beside open water, then the lowest junctions near the
    // district's edge, at least 400 m apart.
    std::vector<std::uint32_t> outfalls;
    for (std::uint32_t i = 0; i < n; ++i)
        if (hg.flags[net.nodes[i].cell] & 1u) outfalls.push_back(i);
    if (outfalls.size() > 32) outfalls.resize(32);
    const double edge_band = std::max(150.0, 0.06 * std::max(hi_x - lo_x, hi_y - lo_y));
    std::vector<std::uint32_t> rim;
    for (std::uint32_t i = 0; i < n; ++i) {
        const auto& pos = s.nodes[i].position;
        if (std::min({pos.x_m - lo_x, hi_x - pos.x_m, pos.y_m - lo_y, hi_y - pos.y_m}) <= edge_band) rim.push_back(i);
    }
    std::sort(rim.begin(), rim.end(), [&](auto a, auto b) {
        return net.nodes[a].ground_m != net.nodes[b].ground_m ? net.nodes[a].ground_m < net.nodes[b].ground_m : a < b;
    });
    std::uint32_t chosen = 0;
    for (const auto i : rim) {
        if (chosen >= p.max_outfalls) break;
        bool apart = true;
        for (const auto o : outfalls) apart = apart && point_distance(s.nodes[i].position, s.nodes[o].position) >= 400;
        if (!apart) continue;
        outfalls.push_back(i);
        ++chosen;
    }
    if (outfalls.empty()) outfalls.push_back(0);
    for (const auto o : outfalls) net.nodes[o].outfall = true;

    // A forest from the outfalls along the streets, preferring to fall: a step
    // whose far end is lower than its near end (water would have to climb
    // towards the outfall) costs `kAdverseCost` metres of pipe per metre of
    // rise, so the network follows the land as gravity sewers do.
    std::vector<double> dist(n, std::numeric_limits<double>::infinity());
    std::vector<std::int64_t> parent(n, -1);
    std::vector<std::uint32_t> order;
    using Item = std::pair<double, std::uint32_t>;
    std::priority_queue<Item, std::vector<Item>, std::greater<Item>> queue;
    for (const auto o : outfalls) {
        dist[o] = 0;
        queue.push({0, o});
    }
    std::vector<bool> done(n, false);
    while (!queue.empty()) {
        const auto [d, u] = queue.top();
        queue.pop();
        if (done[u]) continue;
        done[u] = true;
        order.push_back(u);
        for (const auto& [v, len] : adj[u]) {
            const double cost = len + kAdverseCost * std::max(0.0, net.nodes[u].ground_m - net.nodes[v].ground_m);
            if (!done[v] && (d + cost < dist[v] || (d + cost == dist[v] && std::int64_t(u) < parent[v]))) {
                dist[v] = d + cost;
                parent[v] = u;
                queue.push({dist[v], v});
            }
        }
    }
    // A junction no street joins to an outfall becomes one itself.
    for (std::uint32_t i = 0; i < n; ++i)
        if (!done[i]) {
            net.nodes[i].outfall = true;
            order.push_back(i);
        }

    // Inverts, from the leaves downstream: each junction lies at least the
    // minimum cover below its street, and below every pipe arriving from
    // upstream by at least the minimum fall, so every pipe drains by gravity;
    // the network deepens where the land would not let it fall.
    for (auto& d : net.nodes) d.invert_m = d.ground_m - p.min_cover_m;
    for (auto it = order.rbegin(); it != order.rend(); ++it) {
        const auto u = *it;
        if (parent[u] < 0) continue;
        const auto down = std::size_t(parent[u]);
        const double len = std::max(1.0, point_distance(s.nodes[u].position, s.nodes[down].position));
        net.nodes[down].invert_m = std::min(net.nodes[down].invert_m, net.nodes[u].invert_m - p.min_slope * len);
    }

    // Catchments: each grid cell drains to its nearest junction.
    std::vector<double> catchment(n, 0);
    {
        const double bucket = 100;
        std::vector<std::vector<std::uint32_t>> buckets;
        const auto bw = std::uint32_t((hi_x - lo_x) / bucket) + 1, bh = std::uint32_t((hi_y - lo_y) / bucket) + 1;
        buckets.resize(std::size_t(bw) * bh);
        for (std::uint32_t i = 0; i < n; ++i) {
            const auto& pos = s.nodes[i].position;
            buckets[std::size_t(std::uint32_t((pos.y_m - lo_y) / bucket)) * bw + std::uint32_t((pos.x_m - lo_x) / bucket)].push_back(i);
        }
        for (std::uint32_t j = 0; j < g.height; ++j)
            for (std::uint32_t i = 0; i < g.width; ++i) {
                const double x = g.centre_x(i), y = g.centre_y(j);
                const auto bx = std::int64_t(std::floor((x - lo_x) / bucket)), by = std::int64_t(std::floor((y - lo_y) / bucket));
                double best = 1e300;
                std::int64_t pick = -1;
                for (int radius = 0; radius < 64 && pick < 0; ++radius)
                    for (auto yy = by - radius; yy <= by + radius; ++yy)
                        for (auto xx = bx - radius; xx <= bx + radius; ++xx) {
                            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
                            for (const auto c : buckets[std::size_t(yy) * bw + std::size_t(xx)]) {
                                const auto& pos = s.nodes[c].position;
                                const double d2 = (pos.x_m - x) * (pos.x_m - x) + (pos.y_m - y) * (pos.y_m - y);
                                if (d2 < best || (d2 == best && std::int64_t(c) < pick)) {
                                    best = d2;
                                    pick = c;
                                }
                            }
                        }
                if (pick >= 0 && best < 300.0 * 300.0) catchment[std::size_t(pick)] += net.cell_area_m2;
            }
    }
    // Upstream area, from the leaves down (reverse Dijkstra order).
    std::vector<double> upstream = catchment;
    for (auto it = order.rbegin(); it != order.rend(); ++it)
        if (parent[*it] >= 0) upstream[std::size_t(parent[*it])] += upstream[*it];

    // Pipes, sized for the design storm.
    for (const auto u : order) {
        if (parent[u] < 0) continue;
        DrainPipe pipe;
        pipe.from = u;
        pipe.to = static_cast<std::uint32_t>(parent[u]);
        pipe.length_m = std::max(1.0, point_distance(s.nodes[u].position, s.nodes[pipe.to].position));
        pipe.slope = (net.nodes[u].invert_m - net.nodes[pipe.to].invert_m) / pipe.length_m;
        const double design = p.runoff_coefficient * p.design_rain_mm_h / 3.6e6 * upstream[u];
        pipe.diameter_m = kDiameters.back();
        for (const auto d : kDiameters)
            if (full_capacity(d, pipe.slope, p.manning_n) >= design) {
                pipe.diameter_m = d;
                break;
            }
        pipe.full_capacity_m3_s = full_capacity(pipe.diameter_m, pipe.slope, p.manning_n);
        net.pipes.push_back(pipe);
    }
    // A pipe is never smaller than any pipe feeding it (the design rule that
    // keeps a trunk from choking where it steepens): from the leaves down.
    {
        std::vector<double> widest_in(n, 0);
        std::vector<std::size_t> pipe_of(n, SIZE_MAX);
        for (std::size_t k = 0; k < net.pipes.size(); ++k) pipe_of[net.pipes[k].from] = k;
        for (auto it = order.rbegin(); it != order.rend(); ++it) {
            const auto k = pipe_of[*it];
            if (k == SIZE_MAX) continue;
            auto& pipe = net.pipes[k];
            if (pipe.diameter_m < widest_in[pipe.from]) {
                pipe.diameter_m = widest_in[pipe.from];
                pipe.full_capacity_m3_s = full_capacity(pipe.diameter_m, pipe.slope, p.manning_n);
            }
            widest_in[pipe.to] = std::max(widest_in[pipe.to], pipe.diameter_m);
        }
    }
    std::sort(net.pipes.begin(), net.pipes.end(), [](const auto& a, const auto& b) { return a.from < b.from; });
    for (auto& pipe : net.pipes)
        pipe.conveyance_m3_s = kPi * pipe.diameter_m * pipe.diameter_m / 4 * std::pow(pipe.diameter_m / 4, 2.0 / 3.0) / p.manning_n;

    // Inlets: along every street, a grate every inlet_spacing_m on each kerb,
    // in the grid cells the street crosses, each draining to the nearer end.
    std::map<std::pair<std::uint32_t, std::uint32_t>, double> grates;
    for (std::size_t e = 0; e < s.edges.size(); ++e) {
        const auto& edge = s.edges[e];
        if (edge.from.value > edge.to.value && edge.reverse_twin.value < s.edges.size()) continue;  // one per street
        if (e + 1 >= hg.road_offsets.size()) continue;
        const auto a = hg.road_offsets[e], b = hg.road_offsets[e + 1];
        if (b <= a) continue;
        const double per_cell = 2.0 * edge.length_m / std::max(1.0, p.inlet_spacing_m) / double(b - a);
        const auto& from = s.nodes[edge.from.value].position;
        const auto& to = s.nodes[edge.to.value].position;
        for (auto k = a; k < b; ++k) {
            const auto cell = hg.road_cells[k];
            const double x = g.centre_x(cell % g.width), y = g.centre_y(cell / g.width);
            const double df = std::hypot(x - from.x_m, y - from.y_m), dt = std::hypot(x - to.x_m, y - to.y_m);
            const auto node = df <= dt ? edge.from.value : edge.to.value;
            grates[{cell, node}] += per_cell;
        }
    }
    for (const auto& [key, count] : grates) net.inlets.push_back({key.first, key.second, count});
    for (auto& d : net.nodes) {
        d.shaft_area_m2 = p.manhole_area_m2;
        d.crown_m = d.invert_m + kDiameters.front();
    }
    for (const auto& pipe : net.pipes)
        for (const auto end : {pipe.from, pipe.to}) {
            auto& d = net.nodes[end];
            d.pipe_volume_m3 += 0.5 * pipe.length_m * kPi * pipe.diameter_m * pipe.diameter_m / 4;
            d.crown_m = std::max(d.crown_m, d.invert_m + pipe.diameter_m);
        }
    return net;
}

DrainageState initial_drainage(const DrainageNetwork& net) {
    DrainageState s;
    s.volume.assign(net.nodes.size(), 0);
    s.flow_m3_s.assign(net.pipes.size(), 0);
    s.surcharged.assign(net.nodes.size(), 0);
    return s;
}

namespace {
// Storage: while the pipes fill, a node's volume grows with its share of pipe
// and its shaft; once they are full, with its shaft alone, up to the street
// and beyond (surcharge).
double fill_depth(const DrainNode& d) { return std::max(0.1, d.crown_m - d.invert_m); }
double fill_area(const DrainNode& d) { return d.pipe_volume_m3 / fill_depth(d) + d.shaft_area_m2; }
double full_volume(const DrainNode& d) { return fill_area(d) * fill_depth(d); }

/// Volume (units) at which a node's head reaches `head`.
std::int64_t volume_at(const DrainNode& d, const DrainageNetwork& net, double head) {
    if (d.outfall) return 0;
    const double depth = head - d.invert_m;
    const double v = depth <= 0 ? 0 : depth <= fill_depth(d) ? depth * fill_area(d) : full_volume(d) + (depth - fill_depth(d)) * d.shaft_area_m2;
    return static_cast<std::int64_t>(std::floor(v / unit_m3(net)));
}

/// dV/dH at a node's current state, m^2.
double plan_area(const DrainNode& d, const DrainageNetwork& net, std::int64_t volume) {
    if (d.outfall) return 1e12;
    return double(volume) * unit_m3(net) <= full_volume(d) ? fill_area(d) : d.shaft_area_m2;
}
} // namespace

double node_head(const DrainNode& d, const DrainageNetwork& net, std::int64_t volume) {
    if (d.outfall) return d.invert_m;  // a free outfall
    const double v = double(volume) * unit_m3(net);
    if (v <= full_volume(d)) return d.invert_m + v / fill_area(d);
    return d.crown_m + (v - full_volume(d)) / d.shaft_area_m2;
}

std::vector<std::int64_t> inlet_exchange(const DrainageNetwork& net, const DrainageParams& p, const DrainageState& st,
                                         const std::vector<std::int32_t>& h, double dt, std::vector<std::int32_t>& drain) {
    std::vector<std::int64_t> exchange(net.nodes.size(), 0);
    // What is left of each cell's street water as its inlets take their share,
    // and of each node's water above the street as it backflows.
    std::vector<std::int64_t> left(h.begin(), h.end());
    std::vector<std::int64_t> above(net.nodes.size(), -1);
    const double unit = unit_m3(net);
    for (const auto& inlet : net.inlets) {
        const auto& d = net.nodes[inlet.node];
        const auto node = inlet.node;
        const double street = double(left[inlet.cell]) / kQ24;
        const double head = node_head(d, net, st.volume[node] + exchange[node]);
        const double surface = d.ground_m + street;
        if (head < surface && street > 0) {
            // Capture: a grate works as a weir in shallow water and as an
            // orifice once submerged; whichever passes less governs.
            const double depth = surface - std::max(d.ground_m, head);
            if (depth <= 0) continue;
            const double weir = p.weir_coefficient * p.grate_perimeter_m * std::pow(depth, 1.5);
            const double orifice = p.orifice_coefficient * p.grate_area_m2 * std::sqrt(2 * kGravity * depth);
            const double units = std::floor(inlet.grates * std::min(weir, orifice) * dt / unit);
            const auto take = std::min<std::int64_t>(left[inlet.cell], static_cast<std::int64_t>(units));
            if (take <= 0) continue;
            left[inlet.cell] -= take;
            drain[inlet.cell] += static_cast<std::int32_t>(take);
            exchange[node] += take;
        } else if (head > surface && !d.outfall) {
            // Backflow: a network surcharged above the street lifts water out
            // through the grates, never more than it holds above the street.
            if (above[node] < 0) above[node] = std::max<std::int64_t>(0, st.volume[node] - volume_at(d, net, d.ground_m));
            const double rise = head - surface;
            const double flow = inlet.grates * p.orifice_coefficient * p.grate_area_m2 * std::sqrt(2 * kGravity * rise);
            const auto give = std::min<std::int64_t>(above[node], static_cast<std::int64_t>(std::floor(flow * dt / unit)));
            if (give <= 0) continue;
            above[node] -= give;
            drain[inlet.cell] -= static_cast<std::int32_t>(give);
            left[inlet.cell] += give;
            exchange[node] -= give;
        }
    }
    return exchange;
}

void drainage_step(const DrainageNetwork& net, const DrainageParams& p, DrainageState& st, const std::vector<std::int64_t>& exchange,
                   double dt) {
    // The street gave (or took) exactly these amounts.
    bool any = st.stored != 0;
    for (std::size_t i = 0; i < exchange.size() && i < st.volume.size(); ++i) {
        any = any || exchange[i] != 0;
        st.volume[i] += exchange[i];
        if (exchange[i] > 0) st.inflow += exchange[i];
        else st.backflow -= exchange[i];
    }
    // An empty network with nothing arriving has nothing to route.
    if (!any) {
        std::fill(st.flow_m3_s.begin(), st.flow_m3_s.end(), 0.0);
        st.surcharged_nodes = 0;
        st.full_pipes = 0;
        return;
    }
    const double unit = unit_m3(net);
    const auto nodes = net.nodes.size();
    std::vector<std::int64_t> transfer(net.pipes.size(), 0);
    const int substeps = std::max(1, int(std::lround(dt / std::max(0.1, p.substep_s))));
    const double h = dt / substeps;
    std::vector<std::int64_t> out(nodes, 0);
    for (int step = 0; step < substeps; ++step) {
        std::fill(out.begin(), out.end(), 0);
        for (std::size_t k = 0; k < net.pipes.size(); ++k) {
            const auto& pipe = net.pipes[k];
            const auto& a = net.nodes[pipe.from];
            const auto& b = net.nodes[pipe.to];
            const double ha = node_head(a, net, st.volume[pipe.from]), hb = node_head(b, net, st.volume[pipe.to]);
            // A free outfall's head is its invert, or the water in the pipe's end.
            const double dh = ha - hb;
            if (std::abs(dh) < 1e-9) {
                transfer[k] = 0;
                continue;
            }
            // Manning, driven by the head difference, scaled by how full the pipe is.
            const double depth = std::max(ha - a.invert_m, hb - b.invert_m);
            const double fill = std::clamp(depth / pipe.diameter_m, 0.0, 1.0);
            const double conveyance = pipe.conveyance_m3_s * fill * fill;
            double q = conveyance * std::sqrt(std::abs(dh) / pipe.length_m);
            // Never overshoot: no more than equalises the two heads.
            const double aa = plan_area(a, net, st.volume[pipe.from]), ab = plan_area(b, net, st.volume[pipe.to]);
            const double equalise = std::abs(dh) * aa * ab / (aa + ab) / h;
            q = std::min(q, equalise);
            auto units = static_cast<std::int64_t>(std::floor(q * h / unit));
            if (dh < 0) units = -units;
            transfer[k] = units;
            if (units > 0) out[pipe.from] += units;
            else out[pipe.to] -= units;
        }
        // Donor limit: no node gives more than it holds.
        for (std::size_t k = 0; k < net.pipes.size(); ++k) {
            const auto& pipe = net.pipes[k];
            const auto donor = transfer[k] > 0 ? pipe.from : pipe.to;
            if (out[donor] > st.volume[donor] && out[donor] > 0) {
                // Scale in floating point (the product can exceed 64 bits) and
                // floor the magnitude, so the scaled sum never exceeds the volume.
                const double share = double(st.volume[donor]) / double(out[donor]);
                const auto magnitude = static_cast<std::int64_t>(std::floor(double(std::llabs(transfer[k])) * share));
                transfer[k] = transfer[k] > 0 ? magnitude : -magnitude;
            }
        }
        for (std::size_t k = 0; k < net.pipes.size(); ++k) {
            const auto& pipe = net.pipes[k];
            st.volume[pipe.from] -= transfer[k];
            st.volume[pipe.to] += transfer[k];
            st.flow_m3_s[k] = double(transfer[k]) * unit / h;
        }
        for (std::size_t i = 0; i < nodes; ++i)
            if (net.nodes[i].outfall && st.volume[i] > 0) {
                st.outfall += st.volume[i];
                st.volume[i] = 0;
            }
    }
    // Statistics.
    st.stored = 0;
    st.surcharged_nodes = 0;
    for (std::size_t i = 0; i < nodes; ++i) {
        st.stored += st.volume[i];
        const bool sur = !net.nodes[i].outfall && node_head(net.nodes[i], net, st.volume[i]) > net.nodes[i].ground_m;
        st.surcharged[i] = sur;
        st.surcharged_nodes += sur;
    }
    st.full_pipes = 0;
    for (std::size_t k = 0; k < net.pipes.size(); ++k) {
        const double u = std::abs(st.flow_m3_s[k]) / std::max(1e-9, net.pipes[k].full_capacity_m3_s);
        st.peak_utilisation = std::max(st.peak_utilisation, u);
        const auto& a = net.nodes[net.pipes[k].from];
        st.full_pipes += node_head(a, net, st.volume[net.pipes[k].from]) >= a.crown_m;
    }
    st.peak_surcharged = std::max(st.peak_surcharged, st.surcharged_nodes);
}

nlohmann::json drainage_summary(const DrainageNetwork& net, const DrainageState& st, const DrainageParams& p) {
    const double unit = unit_m3(net);
    std::size_t outfalls = 0;
    double length = 0;
    for (const auto& d : net.nodes) outfalls += d.outfall;
    for (const auto& pipe : net.pipes) length += pipe.length_m;
    const double balance = double(st.inflow - st.backflow - st.outfall - st.stored) * unit;
    return {
        {"source", net.source}, {"data_class", "synthetic: a deterministic approximation, not the city's sewers"},
        {"inlets", net.inlets.size()}, {"junctions", net.nodes.size()}, {"pipes", net.pipes.size()}, {"outfalls", outfalls}, {"pipe_length_m", length},
        {"design_rain_mm_h", p.design_rain_mm_h},
        {"stored_m3", double(st.stored) * unit}, {"inflow_m3", double(st.inflow) * unit}, {"backflow_m3", double(st.backflow) * unit},
        {"outfall_m3", double(st.outfall) * unit}, {"conservation_error_m3", balance},
        {"surcharged_nodes", st.surcharged_nodes}, {"full_pipes", st.full_pipes}, {"peak_utilisation", st.peak_utilisation},
        {"peak_surcharged_nodes", st.peak_surcharged}
    };
}

} // namespace dstns::env
