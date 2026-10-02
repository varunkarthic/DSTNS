// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The environment's shared spatial frame.
//
// Every environmental field (terrain, solar forcing, surface temperature,
// water depth, wind) lives on one uniform grid laid over the district in the
// scenario's local metres: x east, y north, origin at the grid's south-west
// corner. Cell (i, j) covers [origin + i*cell, origin + (i+1)*cell) in x and
// the same in y, and its value stands for its centre. Sharing one grid means
// one module's output is another's input without resampling.

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace dstns::env {

struct GridSpec {
    double origin_x_m{}, origin_y_m{};
    double cell_m{25};
    std::uint32_t width{}, height{};

    [[nodiscard]] std::size_t cells() const { return std::size_t(width) * height; }
    [[nodiscard]] std::size_t index(std::uint32_t i, std::uint32_t j) const { return std::size_t(j) * width + i; }
    [[nodiscard]] double centre_x(std::uint32_t i) const { return origin_x_m + (i + 0.5) * cell_m; }
    [[nodiscard]] double centre_y(std::uint32_t j) const { return origin_y_m + (j + 0.5) * cell_m; }
    /// Continuous cell coordinates of a point: (0.5, 0.5) is the centre of cell (0, 0).
    [[nodiscard]] std::pair<double, double> cell_of(double x_m, double y_m) const {
        return {(x_m - origin_x_m) / cell_m, (y_m - origin_y_m) / cell_m};
    }
    [[nodiscard]] bool contains(double x_m, double y_m) const {
        const auto [u, v] = cell_of(x_m, y_m);
        return u >= 0 && v >= 0 && u < width && v < height;
    }
};

/// Bilinear interpolation of a cell-centred field at a point, clamped to the
/// grid: outside it, the nearest edge value is used.
template <class T>
[[nodiscard]] double sample_bilinear(const GridSpec& g, const T* field, double x_m, double y_m) {
    if (!g.width || !g.height) return 0;
    auto [u, v] = g.cell_of(x_m, y_m);
    u -= 0.5;
    v -= 0.5;
    const double maxu = g.width - 1.0, maxv = g.height - 1.0;
    u = u < 0 ? 0 : (u > maxu ? maxu : u);
    v = v < 0 ? 0 : (v > maxv ? maxv : v);
    const auto i0 = static_cast<std::uint32_t>(std::floor(u)), j0 = static_cast<std::uint32_t>(std::floor(v));
    const auto i1 = i0 + 1 < g.width ? i0 + 1 : i0, j1 = j0 + 1 < g.height ? j0 + 1 : j0;
    const double fu = u - i0, fv = v - j0;
    const double a = field[g.index(i0, j0)], b = field[g.index(i1, j0)];
    const double c = field[g.index(i0, j1)], d = field[g.index(i1, j1)];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
}

/// A field reduced for display: block means over `factor` x `factor` cells,
/// with the factor the smallest that brings both sides within `max_side`.
/// Solver resolution stays where it is; only what is sent shrinks.
template <class T>
[[nodiscard]] std::pair<GridSpec, std::vector<float>> downsample_mean(const GridSpec& g, const T* field, std::uint32_t max_side) {
    const std::uint32_t side = max_side < 1 ? 1 : max_side;
    std::uint32_t factor = 1;
    while ((g.width + factor - 1) / factor > side || (g.height + factor - 1) / factor > side) ++factor;
    GridSpec out{g.origin_x_m, g.origin_y_m, g.cell_m * factor, (g.width + factor - 1) / factor, (g.height + factor - 1) / factor};
    std::vector<float> values(out.cells());
    for (std::uint32_t j = 0; j < out.height; ++j)
        for (std::uint32_t i = 0; i < out.width; ++i) {
            double sum = 0;
            std::uint32_t n = 0;
            for (std::uint32_t dj = 0; dj < factor && j * factor + dj < g.height; ++dj)
                for (std::uint32_t di = 0; di < factor && i * factor + di < g.width; ++di, ++n)
                    sum += double(field[g.index(i * factor + di, j * factor + dj)]);
            values[out.index(i, j)] = n ? static_cast<float>(sum / n) : 0.0f;
        }
    // The last block may be partial; the grid it describes keeps whole cells.
    return {out, values};
}

/// The scenario's local equirectangular projection: x = (lon - lon0) k cos(lat0),
/// y = (lat - lat0) k, with k = 111,320 m per degree, as the OSM loader uses.
struct LocalProjection {
    double lat0{}, lon0{};
    static constexpr double kMetresPerDegree = 111320.0;
    [[nodiscard]] double metres_per_degree_lon() const { return kMetresPerDegree * std::cos(lat0 * 3.141592653589793 / 180.0); }
    [[nodiscard]] std::pair<double, double> to_geo(double x_m, double y_m) const {
        return {lat0 + y_m / kMetresPerDegree, lon0 + x_m / metres_per_degree_lon()};
    }
    [[nodiscard]] std::pair<double, double> to_local(double lat, double lon) const {
        return {(lon - lon0) * metres_per_degree_lon(), (lat - lat0) * kMetresPerDegree};
    }
};

} // namespace dstns::env
