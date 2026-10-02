// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// DEM: decoding, resampling, gradients, road grade, provenance and fallback.
//
// Nothing here touches the network. The Terrarium provider is exercised with
// tiles this test encodes itself and plants in a private cache, holding an
// elevation that is a known linear function of position, so every decoded and
// resampled value can be checked exactly.
#include "dstns/environment/png.hpp"
#include "dstns/environment/terrain.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>

using namespace dstns;
using namespace dstns::env;

namespace {
int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    } else {
        std::cout << "  ok  " << message << '\n';
    }
}
bool near(double a, double b, double tolerance) { return std::abs(a - b) <= tolerance; }

ScenarioConfig grid_config(const std::string& dem) {
    ScenarioConfig c;
    c.playback_duration_s = 600;
    c.grid_width = 6;
    c.grid_height = 5;
    c.day = 0;
    c.environment.dem_source = dem;
    return c;
}

const Seed128 kSeed = Seed128::parse("0x5eed0000000000000000000000000042");

// Elevation planted in the test tiles: one metre per global pixel eastwards.
constexpr double kBase = 250.0;
double planted(double global_px, double origin_px) { return kBase + (global_px - origin_px); }

void write_tile(const std::filesystem::path& path, std::uint32_t zoom, std::uint32_t tx, std::uint32_t ty, double origin_px) {
    (void)zoom;
    (void)ty;
    RgbImage image{256, 256, std::vector<std::uint8_t>(256 * 256 * 3)};
    for (std::uint32_t r = 0; r < 256; ++r)
        for (std::uint32_t c = 0; c < 256; ++c) {
            const double z = planted(double(tx) * 256 + c + 0.5, origin_px);
            const double v = z + 32768.0;
            const auto whole = static_cast<std::uint32_t>(std::floor(v));
            auto* p = &image.rgb[(std::size_t(r) * 256 + c) * 3];
            p[0] = static_cast<std::uint8_t>(whole / 256);
            p[1] = static_cast<std::uint8_t>(whole % 256);
            p[2] = static_cast<std::uint8_t>(std::lround((v - whole) * 256));
        }
    std::filesystem::create_directories(path.parent_path());
    const auto bytes = encode_png(image);
    std::ofstream(path, std::ios::binary).write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
}
} // namespace

int main() {
    std::cout << "png\n";
    {
        RgbImage image{3, 2, {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 200, 100, 50, 0, 255, 128}};
        auto bytes = encode_png(image);
        const auto back = decode_png(bytes);
        check(back.width == 3 && back.height == 2 && back.rgb == image.rgb, "PNG round trip is exact");
        auto corrupt = bytes;
        corrupt[corrupt.size() / 2] ^= 0x55;
        bool refused = false;
        try { (void)decode_png(corrupt); } catch (const PngError&) { refused = true; }
        check(refused, "a corrupted PNG is refused, not decoded into wrong values");
        refused = false;
        try { (void)decode_png(std::vector<std::uint8_t>(bytes.begin(), bytes.begin() + 40)); } catch (const PngError&) { refused = true; }
        check(refused, "a truncated PNG is refused");
    }

    std::cout << "encoding and tiles\n";
    check(terrarium_elevation(128, 0, 0) == 0.0, "Terrarium zero");
    check(terrarium_elevation(128, 100, 128) == 100.5, "Terrarium metres and fraction");
    check(terrarium_elevation(127, 156, 0) == -100.0, "Terrarium below sea level");
    {
        const auto [px, py] = mercator_pixel(0, 0, 0);
        check(near(px, 128, 1e-9) && near(py, 128, 1e-9), "Mercator origin is the centre of tile 0");
        check(terrarium_zoom_for(9.6, 0) == 14 && terrarium_zoom_for(40, 0) == 12 && terrarium_zoom_for(5000, 0) == 10, "zoom chosen from resolution");
    }

    std::cout << "grid interpolation and gradient\n";
    {
        GridSpec g{0, 0, 10, 2, 2};
        const float field[4] = {0, 10, 20, 30};
        check(near(sample_bilinear(g, field, 10, 10), 15, 1e-12), "bilinear at the centre of four cells");
        check(near(sample_bilinear(g, field, 5, 5), 0, 1e-12) && near(sample_bilinear(g, field, -50, -50), 0, 1e-12), "clamped outside the grid");
        GridSpec h{0, 0, 1, 5, 1};
        std::vector<float> holes{1, std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::quiet_NaN(), 4, 5};
        const double share = fill_missing(h, holes);
        check(near(share, 0.4, 1e-12) && std::isfinite(holes[1]) && std::isfinite(holes[2]), "missing cells are filled and counted");
    }

    std::cout << "synthetic terrain and road grade\n";
    {
        const auto slope = ScenarioCompiler{}.compile(kSeed, grid_config("synthetic:slope:0.05"));
        const auto& t = *slope.terrain;
        check(t.provenance.source == "synthetic" && !t.provenance.observed && !t.provenance.degraded, "synthetic terrain is labelled as such");
        bool gradient_ok = true;
        for (std::uint32_t j = 0; j < t.grid.height; ++j)
            for (std::uint32_t i = 0; i < t.grid.width; ++i) {
                const auto k = t.grid.index(i, j);
                gradient_ok = gradient_ok && near(t.dzdx[k], 0.05, 1e-3) && near(t.dzdy[k], 0, 1e-3) && near(t.slope[k], 0.05, 1e-3);
            }
        check(gradient_ok, "the gradient of a 5% plane is (0.05, 0) everywhere");
        bool antisymmetric = true, eastward_up = true, north_level = true;
        for (const auto& e : slope.edges) {
            const auto& twin = slope.edges[e.reverse_twin.value];
            antisymmetric = antisymmetric && near(e.grade, -twin.grade, 1e-12);
            const auto& a = slope.nodes[e.from.value].position;
            const auto& b = slope.nodes[e.to.value].position;
            if (b.x_m - a.x_m > 1) eastward_up = eastward_up && near(e.grade, 0.05, 2e-3);
            if (std::abs(b.x_m - a.x_m) < 1) north_level = north_level && near(e.grade, 0, 2e-3);
        }
        check(antisymmetric, "every edge's grade is the negation of its twin's");
        check(eastward_up, "eastbound edges climb at 5% on a plane rising east");
        check(north_level, "north-south edges are level on that plane");
        check(slope.terrain->max_m > slope.terrain->min_m, "elevation range recorded");

        const auto again = ScenarioCompiler{}.compile(kSeed, grid_config("synthetic:slope:0.05"));
        check(again.terrain->hash == t.hash && again.scenario_hash == slope.scenario_hash, "the same terrain hashes the same");
        const auto steeper = ScenarioCompiler{}.compile(kSeed, grid_config("synthetic:slope:0.08"));
        check(steeper.terrain->hash != t.hash && steeper.scenario_hash != slope.scenario_hash, "different terrain is a different scenario");
        check(steeper.event_hash == slope.event_hash && steeper.graph_hash == slope.graph_hash, "terrain does not move the road graph or scheduled events");

        const auto bowl = ScenarioCompiler{}.compile(kSeed, grid_config("synthetic:bowl:12"));
        const auto& b = *bowl.terrain;
        const double cx = b.grid.origin_x_m + b.grid.width * b.grid.cell_m / 2, cy = b.grid.origin_y_m + b.grid.height * b.grid.cell_m / 2;
        check(near(b.elevation_at(cx, cy), 88, 0.5) && b.min_m < b.max_m, "a bowl is lowest at its centre");
    }

    std::cout << "flat terrain and the default\n";
    {
        const auto flat = ScenarioCompiler{}.compile(kSeed, grid_config("auto"));
        check(flat.terrain && flat.terrain->provenance.source == "flat" && !flat.terrain->provenance.degraded, "a synthetic grid is flat by default, not degraded");
        bool level = true;
        for (const auto& e : flat.edges) level = level && e.grade == 0;
        check(level, "flat terrain gives every road a zero grade");
        ::setenv("DSTNS_DEM_SOURCE", "synthetic:hill:20", 1);
        const auto hill = ScenarioCompiler{}.compile(kSeed, grid_config("auto"));
        ::unsetenv("DSTNS_DEM_SOURCE");
        check(hill.terrain->provenance.source == "synthetic", "DSTNS_DEM_SOURCE decides what auto means");
        const auto pinned = ScenarioCompiler{}.compile(kSeed, grid_config("flat"));
        check(pinned.terrain->provenance.note == "configured", "a configured flat terrain says so");
        bool rejected = false;
        try { (void)ScenarioCompiler{}.compile(kSeed, grid_config("lunar")); } catch (const std::invalid_argument&) { rejected = true; }
        check(rejected, "an unknown DEM source is refused");
    }

    std::cout << "terrarium tiles from the cache\n";
    {
        const auto cache = std::filesystem::temp_directory_path() / "dstns-terrain-tiles";
        std::filesystem::remove_all(cache);
        // Never reach the network: a missing tile must surface as a failure.
        ::setenv("DSTNS_PYTHON", "/usr/bin/false", 1);
        auto config = grid_config("terrarium");
        config.environment.dem_cache_dir = cache.string();

        // Plant every tile the district can need, holding a known ramp.
        const auto probe = ScenarioCompiler{}.compile(kSeed, grid_config("flat"));
        const auto& grid = probe.terrain->grid;
        const auto& proj = probe.terrain->projection;
        const auto [south, west] = proj.to_geo(grid.origin_x_m, grid.origin_y_m);
        const auto [north, east] = proj.to_geo(grid.origin_x_m + grid.width * grid.cell_m, grid.origin_y_m + grid.height * grid.cell_m);
        const auto zoom = terrarium_zoom_for(grid.cell_m / 2, (south + north) / 2);
        const auto [px0, py0] = mercator_pixel(north, west, zoom);
        const auto [px1, py1] = mercator_pixel(south, east, zoom);
        const double origin_px = std::floor(px0);
        for (auto x = std::uint32_t(px0 / 256) - 1; x <= std::uint32_t(px1 / 256) + 1; ++x)
            for (auto y = std::uint32_t(py0 / 256) - 1; y <= std::uint32_t(py1 / 256) + 1; ++y)
                write_tile(cache / "terrarium" / std::to_string(zoom) / std::to_string(x) / (std::to_string(y) + ".png"), zoom, x, y, origin_px);

        const auto real = ScenarioCompiler{}.compile(kSeed, config);
        const auto& t = *real.terrain;
        check(t.provenance.source == "terrarium" && t.provenance.observed && !t.provenance.degraded, "cached tiles decode as observed terrain");
        check(t.provenance.zoom == zoom && t.provenance.note == "cache hit" && !t.provenance.attribution.empty(), "provenance records zoom, cache and attribution");
        bool exact = true;
        for (const auto& n : real.nodes) {
            const auto [lat, lon] = proj.to_geo(n.position.x_m, n.position.y_m);
            const auto [px, py] = mercator_pixel(lat, lon, zoom);
            (void)py;
            // Bilinear interpolation of a linear field on the grid is exact up to
            // the grid's own linear interpolation and centimetre rounding.
            exact = exact && near(n.elevation_m, planted(px, origin_px), 0.05);
        }
        check(exact, "node elevations match the planted ramp to 5 cm");

        // Corrupted tiles with no way to re-fetch: flat, and marked degraded.
        for (auto& entry : std::filesystem::recursive_directory_iterator(cache))
            if (entry.path().extension() == ".png") std::ofstream(entry.path(), std::ios::binary) << "not a png";
        const auto broken = ScenarioCompiler{}.compile(kSeed, config);
        check(broken.terrain->provenance.source == "flat" && broken.terrain->provenance.degraded, "an unreadable tile falls back to flat, marked degraded");
        check(broken.terrain->provenance.note.find("fallback") != std::string::npos, "the fallback says why");
        config.environment.dem_required = true;
        bool required = false;
        try { (void)ScenarioCompiler{}.compile(kSeed, config); } catch (const DemUnavailable&) { required = true; }
        check(required, "with dem_required, a missing DEM stops the run instead");
        ::unsetenv("DSTNS_PYTHON");
        std::filesystem::remove_all(cache);
    }

    std::cout << "grid budget\n";
    {
        Scenario s;
        s.nodes.resize(2);
        s.nodes[1].position = {20000, 20000, 0, 0};
        EnvironmentConfig c;
        c.grid_cell_m = 5;
        c.max_grid_cells = 10000;
        const auto g = environment_grid(s, c);
        check(std::uint64_t(g.width) * g.height <= 10000 && g.cell_m > 5, "a grid over budget is coarsened");
        check(g.origin_x_m <= -c.grid_margin_m + 1e-9 && g.origin_x_m + g.width * g.cell_m >= 20000 + c.grid_margin_m - 1e-9, "the grid covers the district and its margin");
    }

    if (failures) {
        std::cerr << failures << " terrain check(s) failed\n";
        return 1;
    }
    std::cout << "terrain tests passed\n";
    return 0;
}
