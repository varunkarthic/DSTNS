// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/hydrology.hpp"

#include "dstns/environment/raster.hpp"
#include "dstns/environment/terrain.hpp"
#include "dstns/model.hpp"

#include <algorithm>
#include <cmath>

namespace dstns::env {
namespace kernels {
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i64 = std::int64_t;
#define DSTNS_FN inline
#include "dstns_hydrology.h"
#undef DSTNS_FN
} // namespace kernels

namespace {
constexpr double kGravity = 9.81;

std::int32_t to_i32(std::int64_t v) {
    return static_cast<std::int32_t>(std::clamp<std::int64_t>(v, INT32_MIN, INT32_MAX));
}

class CpuHydrology final : public HydrologySolver {
public:
    void install(const HydrologyGrid& grid) override {
        grid_ = &grid;
        limiter_.assign(grid.cells(), 65536);
        next_.assign(grid.cells(), 0);
    }
    void upload(const HydrologyState&) override {}
    void download(HydrologyState&) override {}
    [[nodiscard]] bool host_resident() const override { return true; }
    [[nodiscard]] std::string name() const override { return "cpu"; }

    void advance(HydrologyState& s, const HydrologySources& src, double dt, std::uint32_t substeps, const HydrologyParams& p) override {
        const auto& g = *grid_;
        const auto w = g.grid.width, ht = g.grid.height;
        const auto cells = g.cells();
        // Sources, once per step, before the flow: rain in, then the sinks,
        // each limited by the water there.
        for (std::size_t k = 0; k < cells; ++k) {
            std::int64_t h = s.h[k];
            if (!src.rain.empty()) {
                h += src.rain[k];
                s.ledger.rain += src.rain[k];
            }
            if (!src.evaporation.empty()) {
                const auto e = std::min<std::int64_t>(h, src.evaporation[k]);
                h -= e;
                s.ledger.evaporated += e;
            }
            if (!src.infiltration.empty()) {
                const auto f = std::min<std::int64_t>(h, src.infiltration[k]);
                h -= f;
                s.ledger.infiltrated += f;
            }
            s.h[k] = to_i32(h);
        }
        const auto c = hydrology_coefficients(dt, g.grid.cell_m, p);
        const auto z = [&](std::uint32_t i, std::uint32_t j) { return std::int64_t(g.z_q16[std::size_t(j) * w + i]) << 8; };
        const auto h = [&](std::uint32_t i, std::uint32_t j) { return std::int64_t(s.h[std::size_t(j) * w + i]); };
        for (std::uint32_t n = 0; n < substeps; ++n) {
            // 1. Face fluxes from the current depths and the previous step's
            // discharges (read from a copy, so every face sees the same
            // neighbours whatever order faces are visited in). A boundary face
            // sees a dry ghost cell at the inner cell's ground level, so water
            // can leave the district downhill (free outfall) but never enter it.
            prev_x_ = s.qx;
            prev_y_ = s.qy;
            const auto qxp = [&](std::int64_t i, std::uint32_t j) -> std::int64_t {
                return prev_x_[std::size_t(j) * (w + 1) + std::size_t(std::clamp<std::int64_t>(i, 0, w))];
            };
            const auto qyp = [&](std::uint32_t i, std::int64_t j) -> std::int64_t {
                return prev_y_[std::size_t(std::clamp<std::int64_t>(j, 0, ht)) * w + i];
            };
            for (std::uint32_t j = 0; j < ht; ++j)
                for (std::uint32_t i = 0; i <= w; ++i) {
                    auto& q = s.qx[std::size_t(j) * (w + 1) + i];
                    const auto qc = kernels::hyd_centred(q, qxp(std::int64_t(i) - 1, j), qxp(std::int64_t(i) + 1, j), c.theta);
                    if (i == 0) q = to_i32(std::min<std::int64_t>(0, kernels::hyd_face_flux(q, qc, z(0, j), 0, z(0, j), h(0, j), c.a_q20, c.k_q32, c.hmin)));
                    else if (i == w) q = to_i32(std::max<std::int64_t>(0, kernels::hyd_face_flux(q, qc, z(w - 1, j), h(w - 1, j), z(w - 1, j), 0, c.a_q20, c.k_q32, c.hmin)));
                    else q = to_i32(kernels::hyd_face_flux(q, qc, z(i - 1, j), h(i - 1, j), z(i, j), h(i, j), c.a_q20, c.k_q32, c.hmin));
                }
            for (std::uint32_t j = 0; j <= ht; ++j)
                for (std::uint32_t i = 0; i < w; ++i) {
                    auto& q = s.qy[std::size_t(j) * w + i];
                    const auto qc = kernels::hyd_centred(q, qyp(i, std::int64_t(j) - 1), qyp(i, std::int64_t(j) + 1), c.theta);
                    if (j == 0) q = to_i32(std::min<std::int64_t>(0, kernels::hyd_face_flux(q, qc, z(i, 0), 0, z(i, 0), h(i, 0), c.a_q20, c.k_q32, c.hmin)));
                    else if (j == ht) q = to_i32(std::max<std::int64_t>(0, kernels::hyd_face_flux(q, qc, z(i, ht - 1), h(i, ht - 1), z(i, ht - 1), 0, c.a_q20, c.k_q32, c.hmin)));
                    else q = to_i32(kernels::hyd_face_flux(q, qc, z(i, j - 1), h(i, j - 1), z(i, j), h(i, j), c.a_q20, c.k_q32, c.hmin));
                }
            // 2. Each cell's limiter: what it can honour of what is asked of it.
            for (std::uint32_t j = 0; j < ht; ++j)
                for (std::uint32_t i = 0; i < w; ++i) {
                    const auto west = s.qx[std::size_t(j) * (w + 1) + i], east = s.qx[std::size_t(j) * (w + 1) + i + 1];
                    const auto south = s.qy[std::size_t(j) * w + i], north = s.qy[std::size_t(j + 1) * w + i];
                    std::int64_t out = 0;
                    if (west < 0) out += kernels::hyd_transfer(west, c.c_q24);
                    if (east > 0) out += kernels::hyd_transfer(east, c.c_q24);
                    if (south < 0) out += kernels::hyd_transfer(south, c.c_q24);
                    if (north > 0) out += kernels::hyd_transfer(north, c.c_q24);
                    limiter_[std::size_t(j) * w + i] = kernels::hyd_limiter(h(i, j), out);
                }
            // 3. Move the water: each face's transfer, limited by its donor,
            // taken from one cell and given to the other.
            const auto lim = [&](std::int64_t i, std::int64_t j) -> std::int64_t {
                if (i < 0 || j < 0 || i >= std::int64_t(w) || j >= std::int64_t(ht)) return 65536;
                return limiter_[std::size_t(j) * w + std::size_t(i)];
            };
            std::int64_t boundary = 0;
            for (std::uint32_t j = 0; j < ht; ++j)
                for (std::uint32_t i = 0; i < w; ++i) {
                    const auto west = s.qx[std::size_t(j) * (w + 1) + i], east = s.qx[std::size_t(j) * (w + 1) + i + 1];
                    const auto south = s.qy[std::size_t(j) * w + i], north = s.qy[std::size_t(j + 1) * w + i];
                    const auto flow = [&](std::int64_t q, std::int64_t donor_i, std::int64_t donor_j) {
                        return kernels::hyd_limited(kernels::hyd_transfer(q, c.c_q24), lim(donor_i, donor_j));
                    };
                    std::int64_t dh = 0, leaves = 0;
                    // West face: positive q flows in from i-1, negative flows out.
                    if (west > 0) dh += flow(west, std::int64_t(i) - 1, j);
                    else if (west < 0) { const auto f = flow(west, i, j); dh -= f; if (i == 0) leaves += f; }
                    if (east < 0) dh += flow(east, std::int64_t(i) + 1, j);
                    else if (east > 0) { const auto f = flow(east, i, j); dh -= f; if (i == w - 1) leaves += f; }
                    if (south > 0) dh += flow(south, i, std::int64_t(j) - 1);
                    else if (south < 0) { const auto f = flow(south, i, j); dh -= f; if (j == 0) leaves += f; }
                    if (north < 0) dh += flow(north, i, std::int64_t(j) + 1);
                    else if (north > 0) { const auto f = flow(north, i, j); dh -= f; if (j == ht - 1) leaves += f; }
                    next_[std::size_t(j) * w + i] = h(i, j) + dh;
                    boundary += leaves;
                }
            s.ledger.boundary += boundary;
            // 4. Momentum follows the water that actually moved.
            for (std::uint32_t j = 0; j < ht; ++j)
                for (std::uint32_t i = 0; i <= w; ++i) {
                    auto& q = s.qx[std::size_t(j) * (w + 1) + i];
                    if (q > 0) q = to_i32(kernels::hyd_scaled(q, lim(std::int64_t(i) - 1, j)));
                    else if (q < 0) q = to_i32(kernels::hyd_scaled(q, lim(i, j)));
                }
            for (std::uint32_t j = 0; j <= ht; ++j)
                for (std::uint32_t i = 0; i < w; ++i) {
                    auto& q = s.qy[std::size_t(j) * w + i];
                    if (q > 0) q = to_i32(kernels::hyd_scaled(q, lim(i, std::int64_t(j) - 1)));
                    else if (q < 0) q = to_i32(kernels::hyd_scaled(q, lim(i, j)));
                }
            // 5. Open water takes what reaches it.
            for (std::size_t k = 0; k < cells; ++k) {
                if (g.flags[k] & kernels::HYD_SEA) {
                    s.ledger.sea += next_[k];
                    next_[k] = 0;
                }
                s.h[k] = to_i32(next_[k]);
            }
        }
        summarise(s);
    }

    void summarise(HydrologyState& s) const {
        const auto& g = *grid_;
        std::int64_t stored = 0, h_max = 0;
        std::uint32_t wet = 0, flooded = 0;
        const std::int64_t wet_q24 = std::llround(0.001 * kQ24), flooded_q24 = std::llround(0.10 * kQ24);
        for (const auto v : s.h) {
            stored += v;
            h_max = std::max<std::int64_t>(h_max, v);
            wet += v >= wet_q24;
            flooded += v >= flooded_q24;
        }
        s.stored = stored;
        s.h_max = h_max;
        s.wet_cells = wet;
        s.flooded_cells = flooded;
        const auto edges = g.road_offsets.empty() ? 0 : g.road_offsets.size() - 1;
        s.road_max.assign(edges, 0);
        s.road_mean.assign(edges, 0);
        for (std::size_t e = 0; e < edges; ++e) {
            std::int64_t sum = 0, deepest = 0;
            const auto a = g.road_offsets[e], b = g.road_offsets[e + 1];
            for (auto k = a; k < b; ++k) {
                sum += s.h[g.road_cells[k]];
                deepest = std::max<std::int64_t>(deepest, s.h[g.road_cells[k]]);
            }
            s.road_max[e] = to_i32(deepest);
            s.road_mean[e] = b > a ? to_i32(sum / std::int64_t(b - a)) : 0;
        }
    }

private:
    const HydrologyGrid* grid_{};
    std::vector<std::int64_t> limiter_, next_;
    std::vector<std::int32_t> prev_x_, prev_y_;
};

} // namespace

// Froude number per wet cell from the mean of its face discharges:
// Fr = |u| / sqrt(g h), u = q / h. Cells above 0.5 with a sharp depth step
// to a neighbour are where a 2D depth-averaged model is weakest.
HydrologyCoefficients hydrology_coefficients(double dt, double dx, const HydrologyParams& p) {
    HydrologyCoefficients c;
    c.a_q20 = std::llround(kGravity * dt / dx * kQ20);
    c.k_q32 = std::llround(kGravity * dt * p.manning_n * p.manning_n * 4294967296.0);
    c.c_q24 = std::llround(dt / dx * kQ24);
    c.hmin = std::llround(p.min_flow_depth_m * kQ24);
    c.theta = std::llround(std::clamp(p.theta, 0.0, 1.0) * 65536.0);
    return c;
}

void detect_hotspots(const HydrologyGrid& g, HydrologyState& s) {
    const auto w = g.grid.width, ht = g.grid.height;
    const std::int64_t wet = std::llround(0.05 * kQ24);
    std::vector<std::pair<double, std::uint32_t>> found;
    double max_fr = 0;
    std::uint32_t supercritical = 0;
    for (std::uint32_t j = 0; j < ht; ++j)
        for (std::uint32_t i = 0; i < w; ++i) {
            const auto k = std::size_t(j) * w + i;
            if (s.h[k] < wet) continue;
            const double h = s.h[k] / kQ24;
            const double qx = (s.qx[std::size_t(j) * (w + 1) + i] + s.qx[std::size_t(j) * (w + 1) + i + 1]) / (2 * kQ20);
            const double qy = (s.qy[std::size_t(j) * w + i] + s.qy[std::size_t(j + 1) * w + i]) / (2 * kQ20);
            const double fr = std::hypot(qx, qy) / h / std::sqrt(kGravity * h);
            max_fr = std::max(max_fr, fr);
            if (fr <= 0.5) continue;
            ++supercritical;
            double step = 0;
            if (i > 0) step = std::max(step, std::abs(double(s.h[k] - s.h[k - 1])));
            if (i + 1 < w) step = std::max(step, std::abs(double(s.h[k] - s.h[k + 1])));
            if (j > 0) step = std::max(step, std::abs(double(s.h[k] - s.h[k - w])));
            if (j + 1 < ht) step = std::max(step, std::abs(double(s.h[k] - s.h[k + w])));
            if (step > 0.5 * s.h[k]) found.push_back({fr, static_cast<std::uint32_t>(k)});
        }
    std::sort(found.begin(), found.end(), [](const auto& a, const auto& b) { return a.first != b.first ? a.first > b.first : a.second < b.second; });
    s.max_froude = max_fr;
    s.supercritical_cells = supercritical;
    s.hotspots.clear();
    for (std::size_t n = 0; n < found.size() && n < 8; ++n) s.hotspots.push_back(found[n].second);
}

HydrologyGrid build_hydrology_grid(const Scenario& s, const Terrain& t, const HydrologyParams& p) {
    HydrologyGrid g;
    g.grid = t.grid;
    const auto cells = g.cells();
    g.z_q16.resize(cells);
    g.flags.assign(cells, 0);
    g.pervious.assign(cells, 0);
    for (std::size_t k = 0; k < cells; ++k) {
        g.z_q16[k] = static_cast<std::int32_t>(std::llround(std::clamp<double>(t.elevation_m[k], -30000, 30000) * 65536.0));
        if (t.elevation_m[k] < t.sea_mask_m) g.flags[k] |= kernels::HYD_SEA;
    }
    for (const auto& f : s.features) {
        if (is_open_water(f)) rasterize_polygon(g.grid, f.geometry, [&](std::size_t k) { g.flags[k] |= kernels::HYD_SEA; });
        else if (is_pervious(f)) rasterize_polygon(g.grid, f.geometry, [&](std::size_t k) { g.pervious[k] = 1; });
    }
    g.infiltration_m_s.resize(cells);
    for (std::size_t k = 0; k < cells; ++k)
        g.infiltration_m_s[k] = static_cast<float>((g.pervious[k] ? p.pervious_infiltration_mm_h : p.impervious_infiltration_mm_h) / 3.6e6);
    g.road_offsets.reserve(s.edges.size() + 1);
    g.road_offsets.push_back(0);
    for (const auto& e : s.edges) {
        auto line = e.geometry;
        if (line.size() < 2 && e.from.value < s.nodes.size() && e.to.value < s.nodes.size())
            line = {s.nodes[e.from.value].position, s.nodes[e.to.value].position};
        const auto crossed = cells_along(g.grid, line);
        g.road_cells.insert(g.road_cells.end(), crossed.begin(), crossed.end());
        g.road_offsets.push_back(static_cast<std::uint32_t>(g.road_cells.size()));
    }
    return g;
}

HydrologyState initial_hydrology(const HydrologyGrid& g) {
    HydrologyState s;
    s.h.assign(g.cells(), 0);
    s.qx.assign(g.faces_x(), 0);
    s.qy.assign(g.faces_y(), 0);
    s.rain_carry.assign(g.cells(), 0);
    s.evap_carry.assign(g.cells(), 0);
    const auto edges = g.road_offsets.empty() ? 0 : g.road_offsets.size() - 1;
    s.road_max.assign(edges, 0);
    s.road_mean.assign(edges, 0);
    return s;
}

std::unique_ptr<HydrologySolver> make_cpu_hydrology_solver() { return std::make_unique<CpuHydrology>(); }

SubStepping hydrology_substeps(double interval_s, double cell_m, std::int64_t h_max_q24, const HydrologyParams& p) {
    const double h = std::max(p.min_flow_depth_m, double(h_max_q24) / kQ24);
    const double limit = p.cfl * cell_m / std::sqrt(kGravity * h);
    SubStepping out;
    const double wanted = std::ceil(interval_s / limit);
    out.capped = wanted > p.max_substeps;
    out.substeps = static_cast<std::uint32_t>(std::clamp(wanted, 1.0, double(p.max_substeps)));
    out.dt_s = interval_s / out.substeps;
    return out;
}

} // namespace dstns::env
