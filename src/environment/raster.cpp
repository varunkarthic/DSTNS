// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/raster.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <string>

namespace dstns::env {
namespace {
std::string tag(const MapFeature& f, const char* key) {
    const auto it = f.tags.find(key);
    return it == f.tags.end() ? std::string{} : it->second;
}
bool any_of(const std::string& v, std::initializer_list<const char*> values) {
    for (const auto* x : values)
        if (v == x) return true;
    return false;
}
} // namespace

void rasterize_polygon(const GridSpec& g, const std::vector<Point>& ring, const std::function<void(std::size_t)>& mark) {
    if (ring.size() < 3 || !g.width || !g.height) return;
    double lo_x = ring[0].x_m, hi_x = lo_x, lo_y = ring[0].y_m, hi_y = lo_y;
    for (const auto& p : ring) {
        lo_x = std::min(lo_x, p.x_m);
        hi_x = std::max(hi_x, p.x_m);
        lo_y = std::min(lo_y, p.y_m);
        hi_y = std::max(hi_y, p.y_m);
    }
    const auto clamp_i = [&](double v, std::uint32_t n) { return static_cast<std::int64_t>(std::clamp(v, 0.0, double(n) - 1)); };
    const auto i0 = clamp_i(std::floor((lo_x - g.origin_x_m) / g.cell_m), g.width), i1 = clamp_i(std::floor((hi_x - g.origin_x_m) / g.cell_m), g.width);
    const auto j0 = clamp_i(std::floor((lo_y - g.origin_y_m) / g.cell_m), g.height), j1 = clamp_i(std::floor((hi_y - g.origin_y_m) / g.cell_m), g.height);
    const std::size_t n = ring.size();
    for (auto j = j0; j <= j1; ++j)
        for (auto i = i0; i <= i1; ++i) {
            const double x = g.centre_x(std::uint32_t(i)), y = g.centre_y(std::uint32_t(j));
            bool inside = false;
            for (std::size_t a = 0, b = n - 1; a < n; b = a++) {
                const auto& p = ring[a];
                const auto& q = ring[b];
                if ((p.y_m > y) != (q.y_m > y) && x < (q.x_m - p.x_m) * (y - p.y_m) / (q.y_m - p.y_m) + p.x_m) inside = !inside;
            }
            if (inside) mark(g.index(std::uint32_t(i), std::uint32_t(j)));
        }
}

std::vector<std::uint32_t> cells_along(const GridSpec& g, const std::vector<Point>& line) {
    std::vector<std::uint32_t> out;
    const auto add = [&](double x, double y) {
        if (!g.contains(x, y)) return;
        const auto [u, v] = g.cell_of(x, y);
        const auto k = static_cast<std::uint32_t>(g.index(std::uint32_t(u), std::uint32_t(v)));
        if (out.empty() || out.back() != k) out.push_back(k);
    };
    if (line.empty()) return out;
    add(line[0].x_m, line[0].y_m);
    for (std::size_t s = 1; s < line.size(); ++s) {
        const auto& a = line[s - 1];
        const auto& b = line[s];
        const double d = std::hypot(b.x_m - a.x_m, b.y_m - a.y_m);
        const int steps = std::max(1, int(std::ceil(d / (g.cell_m / 2))));
        for (int k = 1; k <= steps; ++k) add(a.x_m + (b.x_m - a.x_m) * k / steps, a.y_m + (b.y_m - a.y_m) * k / steps);
    }
    return out;
}

bool is_pervious(const MapFeature& f) {
    if (!f.polygon) return false;
    return any_of(tag(f, "leisure"), {"park", "garden", "pitch", "playground", "golf_course", "nature_reserve", "recreation_ground", "dog_park"}) ||
           any_of(tag(f, "landuse"), {"grass", "forest", "meadow", "recreation_ground", "village_green", "cemetery", "allotments",
                                      "farmland", "orchard", "vineyard", "greenfield", "flowerbed"}) ||
           any_of(tag(f, "natural"), {"wood", "scrub", "grassland", "heath"});
}

bool is_open_water(const MapFeature& f) {
    if (!f.polygon) return false;
    return any_of(tag(f, "landuse"), {"basin", "reservoir"}) || tag(f, "natural") == "water" || tag(f, "waterway") == "riverbank";
}

} // namespace dstns::env
