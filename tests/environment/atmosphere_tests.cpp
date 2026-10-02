// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// DAS: building heights, the urban canopy, the background wind climate, and
// the lattice Boltzmann wind field: uniform over open flat ground, the log
// law aloft, sheltering in and behind a block of tall buildings, updrafts
// over heated streets, and determinism.
#include "dstns/environment/atmosphere.hpp"
#include "dstns/engine.hpp"
#include "dstns/environment/runtime.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <chrono>
#include <cmath>
#include <filesystem>
#include <iostream>
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

Scenario world(const std::string& dem = "flat", std::uint32_t side = 12) {
    ScenarioConfig c;
    c.playback_duration_s = 600;
    c.grid_width = side;
    c.grid_height = side;
    c.day = 0;
    c.month = 7;
    c.environment.dem_source = dem;
    return ScenarioCompiler{}.compile(Seed128::parse("0x5eed00000000000000000000000000a7"), c);
}

MapFeature block(double x0, double y0, double x1, double y1, const std::string& height) {
    MapFeature f;
    f.id = "way/" + std::to_string(int(x0)) + "_" + std::to_string(int(y0));
    f.polygon = true;
    f.tags = {{"building", "yes"}};
    if (!height.empty()) f.tags["height"] = height;
    f.geometry = {{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}, {x0, y0}};
    return f;
}

double speed(const WindSolution& s, std::size_t c) { return std::hypot(s.u[c], s.v[c]); }
} // namespace

int main() {
    AtmosphereParams p;

    std::cout << "building heights\n";
    {
        std::string source;
        check(building_height({{"building", "yes"}, {"height", "24"}}, p, &source) == 24 && source == "height", "a height tag is taken as metres");
        check(std::abs(building_height({{"building", "yes"}, {"height", "100'"}}, p) - 30.48) < 1e-9, "or feet, when it says so");
        check(building_height({{"building", "yes"}, {"building:levels", "5"}}, p, &source) == 15 && source == "levels", "else storeys of 3 m");
        check(building_height({{"building", "garage"}}, p, &source) == p.small_height_m && source == "estimated", "else an estimate by kind");
        check(building_height({{"building", "yes"}, {"height", "tall"}}, p) == p.default_height_m, "a height that is not a number is ignored");
    }

    auto s = world();
    const auto& g = s.terrain->grid;
    std::cout << "grid " << g.width << "x" << g.height << " at " << g.cell_m << " m\n";

    std::cout << "open flat ground\n";
    const auto open_canopy = build_canopy(s, g, p);
    const auto open = build_lattice(*s.terrain, open_canopy, p);
    std::cout << "      lattice " << open.nx << "x" << open.ny << "x" << open.nz << " at " << open.dx_m << " m\n";
    const auto column = [&](const AtmosphereLattice& L, double x, double y) {
        const auto [u, v] = L.columns.cell_of(x, y);
        return std::size_t(std::uint32_t(v)) * L.nx + std::uint32_t(u);
    };
    const double cx = g.origin_x_m + g.width * g.cell_m / 2, cy = g.origin_y_m + g.height * g.cell_m / 2;
    {
        const auto t0 = std::chrono::steady_clock::now();
        const auto sol = solve_wind(open, {4.0, 270}, {}, 20, p);
        const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        double lo = 1e9, hi = 0, cross = 0;
        for (std::size_t c = 0; c < sol.u.size(); ++c) {
            lo = std::min(lo, speed(sol, c));
            hi = std::max(hi, speed(sol, c));
            cross = std::max(cross, double(std::abs(sol.v[c])));
        }
        std::cout << "      " << sol.iterations << " iterations in " << ms << " ms; speed " << lo << ".." << hi << " of the background, Mach "
                  << sol.max_mach << ", mean density error " << sol.mean_density_error << '\n';
        check(lo > 0.9 && hi < 1.15, "over open flat ground the wind is the background wind, within 15%");
        check(sol.u[column(open, cx, cy)] > 0.95 && cross < 0.02, "a westerly blows east, with no sideways drift");
        const auto north = solve_wind(open, {4.0, 0}, {}, 20, p);
        const auto c = column(open, cx, cy);
        check(north.v[c] < -0.95 && std::abs(north.u[c]) < 0.02, "a northerly blows south");
        check(std::abs(speed(north, c) - speed(sol, c)) < 0.01, "the lattice has no preferred direction (west and north agree)");
        check(sol.max_mach < 0.3 && sol.mean_density_error < 1e-3, "the flow stays well below the lattice's speed of sound");
        // The inflow profile itself: the log law.
        const double z0 = 0.03;
        check(std::abs(log_profile(10, z0, 10) - 1) < 1e-12 && std::abs(log_profile(100, z0, 10) / log_profile(50, z0, 10) - std::log(100 / z0 + 1) / std::log(50 / z0 + 1)) < 1e-9,
              "the boundary profile is logarithmic in height");
        auto one = p, three = p;
        one.threads = 1;
        three.threads = 3;
        const auto a = solve_wind(open, {4.0, 250}, {}, 20, one), b = solve_wind(open, {4.0, 250}, {}, 20, three);
        check(a.u == b.u && a.v == b.v && a.w == b.w, "one thread and three compute the same bits");
    }

    std::cout << "a block of tall buildings\n";
    {
        auto built = s;
        // 400 m x 400 m of 40 m buildings, 30 m wide with 20 m streets between.
        for (int bx = 0; bx < 8; ++bx)
            for (int by = 0; by < 8; ++by) {
                const double x0 = cx - 200 + bx * 50, y0 = cy - 200 + by * 50;
                built.features.push_back(block(x0, y0, x0 + 30, y0 + 30, "40"));
            }
        const auto canopy = build_canopy(built, g, p);
        check(canopy.buildings == 64 && canopy.height_tagged == 64, "every footprint is counted, with its tagged height");
        double lp = 0;
        int n = 0;
        for (std::uint32_t j = 0; j < g.height; ++j)
            for (std::uint32_t i = 0; i < g.width; ++i)
                if (std::abs(g.centre_x(i) - cx) < 200 && std::abs(g.centre_y(j) - cy) < 200) {
                    lp += canopy.plan_fraction[g.index(i, j)];
                    ++n;
                }
        lp /= n;
        std::cout << "      plan fraction over the block " << lp << ", district " << canopy.built_fraction << ", mean height " << canopy.mean_height_m << " m\n";
        check(std::abs(canopy.mean_height_m - 40) < 1e-3 && std::abs(lp - 0.36) < 0.03, "the canopy has the block's height and its plan fraction, 64 x 900 m2 over 400 m x 400 m");
        const auto L = build_lattice(*built.terrain, canopy, p);
        const auto sol = solve_wind(L, {4.0, 270}, {}, 20, p);
        const auto at = [&](double dx, double dy) { return speed(sol, column(L, cx + dx, cy + dy)); };
        std::cout << "      west-east through the block:";
        for (double dx = -900; dx <= 900; dx += 150) std::cout << ' ' << at(dx, 0);
        std::cout << "\n      beside it (500 m north):";
        for (double dx = -900; dx <= 900; dx += 150) std::cout << ' ' << at(dx, 500);
        std::cout << '\n';
        check(at(0, 0) < 0.6 * at(-900, 0), "inside the block the wind is less than 60% of the upwind wind");
        check(at(350, 0) < at(-350, 0), "the wake downwind is calmer than the same distance upwind");
        check(at(350, 0) < 0.9 * at(350, 600), "and calmer than open ground at the same distance downwind");
        check(at(-900, 0) > 0.9, "far upwind the block is not felt");
    }

    std::cout << "a heated patch in light wind\n";
    {
        const std::size_t columns = std::size_t(open.nx) * open.ny;
        std::vector<float> neutral(columns, 0), heated(columns, 0);
        for (std::uint32_t j = 0; j < open.ny; ++j)
            for (std::uint32_t i = 0; i < open.nx; ++i) {
                const double x = open.columns.centre_x(i) - cx, y = open.columns.centre_y(j) - cy;
                if (std::abs(x) < 300 && std::abs(y) < 300) heated[std::size_t(j) * open.nx + i] = 12;
            }
        const auto calm = solve_wind(open, {1.0, 270}, neutral, 25, p);
        const auto warm = solve_wind(open, {1.0, 270}, heated, 25, p);
        const auto c = column(open, cx, cy);
        const auto west = column(open, cx - 400, cy), east = column(open, cx + 400, cy);
        const auto south = column(open, cx, cy - 400), north = column(open, cx, cy + 400);
        std::cout << "      w at the centre " << calm.w[c] << " -> " << warm.w[c] << "; u west " << calm.u[west] << " -> " << warm.u[west] << ", east "
                  << calm.u[east] << " -> " << warm.u[east] << "; v south " << warm.v[south] << ", north " << warm.v[north] << '\n';
        check(warm.w[c] > calm.w[c] + 0.01, "warm air rises over the heated streets");
        check(warm.u[west] - calm.u[west] > 0 && warm.u[east] - calm.u[east] < 0, "and air near the ground converges on them from west and east");
        check(warm.v[south] > 0 && warm.v[north] < 0, "and from south and north");
    }

    std::cout << "the wind climate\n";
    {
        const auto berlin = wind_climate(s, 52.5), dar = wind_climate(s, -6.8), singapore = wind_climate(s, 1.3), tromso = wind_climate(s, 69.6);
        const auto mumbai = wind_climate(s, 19.1);
        check(berlin.belt == "westerlies" && mumbai.belt == "trades" && dar.belt == "doldrums" && tromso.belt == "polar easterlies" &&
                  singapore.belt == "doldrums",
              "each latitude has its wind belt");
        const auto angle = [](double a, double b) { return std::abs(std::remainder(a - b, 360.0)); };
        check(angle(berlin.prevailing_from_deg, 250) < 120 && angle(mumbai.prevailing_from_deg, 60) < 120,
              "westerlies blow from the west, trades from the north-east (give or take the day)");
        const auto again = wind_climate(world(), 52.5);
        check(again.prevailing_from_deg == berlin.prevailing_from_deg && again.mean_speed_mps == berlin.mean_speed_mps, "a seed always has the same day's wind");
        ScenarioConfig other;
        other.grid_width = other.grid_height = 6;
        other.month = 7;
        other.environment.dem_source = "flat";
        const auto different = wind_climate(ScenarioCompiler{}.compile(Seed128::parse("0x5eed000000000000000000000000ffff"), other), 52.5);
        check(different.prevailing_from_deg != berlin.prevailing_from_deg, "and another seed another");
        check(background_wind(berlin, 15).speed_mps > background_wind(berlin, 4).speed_mps, "the surface wind is stronger in the afternoon than before dawn");
        check(berlin.mean_speed_mps > 1 && berlin.mean_speed_mps < 10, "and of an ordinary strength");
    }

    std::cout << "the runtime: roads, gusts\n";
    {
        EnvironmentRuntime rt;
        rt.install(s);
        EnvironmentInputs in;
        in.hydrology = false;
        for (std::uint32_t t = 1; t <= 60; ++t) {
            in.virtual_s = 12 * 3600 + t;
            rt.step(in);
        }
        const auto summary = rt.summary()["atmosphere"];
        check(summary["solved"] == true && summary["lattice"]["nz"].get<int>() >= 8, "the first minute solves the wind");
        const auto* field = rt.field("wind");
        check(field && field->size() == g.cells(), "the wind field is published on the environment grid");
        const auto bg = summary["background"]["speed_mps"].get<double>();
        double mean = 0;
        for (const auto v : *field) mean += v;
        mean /= double(field->size());
        check(std::abs(mean / bg - 1) < 0.15, "over open ground it averages the background speed");
        bool antisymmetric = true, more_energy = true;
        int into = 0;
        for (const auto& e : s.edges) {
            if (e.reverse_twin.value >= s.edges.size()) continue;
            const auto a = rt.road(e.id.value, true), b = rt.road(e.reverse_twin.value, true);
            antisymmetric = antisymmetric && std::abs(a.headwind_mps + b.headwind_mps) < 0.3;
            if (a.headwind_mps > 1) {
                ++into;
                more_energy = more_energy && a.energy_kwh_per_km > b.energy_kwh_per_km;
            }
        }
        check(into > 0 && antisymmetric, "a road's headwind is its twin's tailwind");
        check(more_energy, "and driving into it costs more energy than with it");
        // A storm overhead freshens the wind beneath it.
        const auto [u0, v0] = rt.wind_at(cx, cy);
        in.storms = {{cx, cy, 800, 1.0}};
        for (std::uint32_t t = 61; t <= 120; ++t) {
            in.virtual_s = 12 * 3600 + t;
            rt.step(in);
        }
        const auto [u1, v1] = rt.wind_at(cx, cy);
        std::cout << "      at the centre " << std::hypot(u0, v0) << " m/s, under the storm " << std::hypot(u1, v1) << " m/s\n";
        check(std::hypot(u1, v1) > 1.4 * std::hypot(u0, v0), "a storm's core gusts well above the background");
        in.das = false;
        for (std::uint32_t t = 121; t <= 180; ++t) {
            in.virtual_s = 12 * 3600 + t;
            rt.step(in);
        }
        check(rt.road(0).headwind_mps == 0 && !rt.field("wind"), "switched off, the wind leaves the roads and the map");
    }

    std::cout << "through the engine\n";
    {
        const auto dir = std::filesystem::temp_directory_path() / "dstns-atmosphere-test";
        std::filesystem::remove_all(dir);
        {
            RuntimeLogger logger(dir);
            SimulationEngine engine(logger);
            ScenarioConfig c;
            c.playback_duration_s = 600;
            c.grid_width = 8;
            c.grid_height = 8;
            c.dws_frequency = 0;
            c.environment.dem_source = "synthetic:hill:30";
            engine.prepare(Seed128::parse("0x5eed00000000000000000000000000a8"), c);
            engine.seek(14 * 3600, false);
            const auto direct = engine.wind()["data"];
            const auto atmosphere = engine.environment()["data"]["state"]["atmosphere"];
            check(direct["solved"] == true && direct["u"].size() == direct["width"].get<std::size_t>() * direct["height"].get<std::size_t>(),
                  "the wind view gives both components on the lattice");
            engine.seek(9 * 3600, false);
            engine.seek(14 * 3600, false);
            check(engine.wind()["data"] == direct && engine.environment()["data"]["state"]["atmosphere"] == atmosphere,
                  "rewinding and replaying reproduces the wind exactly");
            // A storm drifts downwind.
            const auto from = atmosphere["background"]["from_deg"].get<double>() * 3.141592653589793 / 180;
            engine.add_weather(NodeId{0}, 1.0, 600, 120, 0.2);
            engine.seek(14 * 3600 + 600, false);
            const auto first = engine.snapshot()["data"]["active_weather"][0];
            engine.seek(14 * 3600 + 4800, false);
            const auto later = engine.snapshot()["data"]["active_weather"][0];
            const double dx = later["x_m"].get<double>() - first["x_m"].get<double>(), dy = later["y_m"].get<double>() - first["y_m"].get<double>();
            const double off = std::abs(std::remainder(std::atan2(dy, dx) - std::atan2(-std::cos(from), -std::sin(from)), 2 * 3.141592653589793));
            std::cout << "      the storm moved " << std::hypot(dx, dy) << " m, " << off * 180 / 3.141592653589793 << " degrees off downwind\n";
            check(std::hypot(dx, dy) > 50 && off < 0.1, "a storm drifts downwind");
            engine.terminate();
        }
        std::filesystem::remove_all(dir);
    }

    if (failures) {
        std::cerr << failures << " atmosphere check(s) failed\n";
        return 1;
    }
    std::cout << "atmosphere tests passed\n";
    return 0;
}
