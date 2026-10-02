// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Surface water: canonical validation problems for the local-inertial
// shallow-water solver, the water ledger, and the runtime around it.
//
//   lake at rest      a still pond over an uneven bed stays exactly still
//   dam break         the wet front and the dam-site depth against Ritter (1892)
//   slope             water runs downhill and leaves at the low edge
//   basin             rain collects in a closed depression and stays there
//   positivity        no cell ever goes below zero, whatever the forcing
//   ledger            stored = initial + rain - outflows - sinks, exactly, every step
#include "dstns/engine.hpp"
#include "dstns/environment/hydrology.hpp"
#include "dstns/environment/runtime.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <algorithm>
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
bool near(double a, double b, double tolerance) { return std::abs(a - b) <= tolerance; }

std::int32_t q24(double metres) { return static_cast<std::int32_t>(std::llround(metres * kQ24)); }
double metres(std::int64_t v) { return double(v) / kQ24; }

HydrologyGrid grid(std::uint32_t w, std::uint32_t h, double cell, const std::function<double(double, double)>& z) {
    HydrologyGrid g;
    g.grid = {0, 0, cell, w, h};
    g.z_q16.resize(g.cells());
    g.flags.assign(g.cells(), 0);
    g.pervious.assign(g.cells(), 0);
    g.infiltration_m_s.assign(g.cells(), 0);
    for (std::uint32_t j = 0; j < h; ++j)
        for (std::uint32_t i = 0; i < w; ++i) g.z_q16[g.grid.index(i, j)] = static_cast<std::int32_t>(std::llround(z(g.grid.centre_x(i), g.grid.centre_y(j)) * 65536));
    g.road_offsets = {0};
    return g;
}

/// Advance `seconds` in steps of `interval`, with CFL substeps; check the ledger every step.
bool run(HydrologySolver& solver, const HydrologyGrid& g, HydrologyState& s, double seconds, double interval,
         const HydrologyParams& p, const std::function<HydrologySources(int)>& sources = {}) {
    bool exact = true;
    const int steps = int(std::lround(seconds / interval));
    for (int n = 0; n < steps; ++n) {
        const auto sub = hydrology_substeps(interval, g.grid.cell_m, s.h_max, p);
        solver.advance(s, sources ? sources(n) : HydrologySources{}, sub.dt_s, sub.substeps, p);
        exact = exact && s.ledger.expected() == s.stored;
        for (const auto v : s.h) exact = exact && v >= 0;
    }
    return exact;
}

/// Raise the outermost ring of cells into a wall `height` metres high, dry.
void wall(HydrologyGrid& g, HydrologyState& s, double height) {
    const auto w = g.grid.width, h = g.grid.height;
    for (std::uint32_t j = 0; j < h; ++j)
        for (std::uint32_t i = 0; i < w; ++i)
            if (i == 0 || j == 0 || i + 1 == w || j + 1 == h) {
                g.z_q16[g.grid.index(i, j)] = static_cast<std::int32_t>(height * 65536);
                s.h[g.grid.index(i, j)] = 0;
            }
}

std::int64_t total(const HydrologyState& s) {
    std::int64_t sum = 0;
    for (const auto v : s.h) sum += v;
    return sum;
}

void start(HydrologyState& s) {
    s.stored = total(s);
    s.ledger.initial = s.stored;
    s.h_max = *std::max_element(s.h.begin(), s.h.end());
}
} // namespace

int main() {
    HydrologyParams p;

    std::cout << "lake at rest\n";
    {
        // An uneven bed under a flat water surface at 2 m: no force, no flow.
        auto g = grid(24, 24, 10, [](double x, double y) { return 0.6 + 0.5 * std::sin(x / 17) * std::cos(y / 23); });
        auto s = initial_hydrology(g);
        for (std::size_t k = 0; k < g.cells(); ++k) s.h[k] = q24(2.0) - (g.z_q16[k] << 8);
        start(s);
        const auto before = s.h;
        auto solver = make_cpu_hydrology_solver();
        solver->install(g);
        // Walls: a free-outfall edge would drain the lake, so raise a rim.
        for (std::uint32_t i = 0; i < 24; ++i)
            for (const auto k : {g.grid.index(i, 0), g.grid.index(i, 23), g.grid.index(0, i), g.grid.index(23, i)}) {
                g.z_q16[k] = 3 * 65536;
                s.h[k] = 0;
            }
        start(s);
        const auto rim_before = s.h;
        const bool ok = run(*solver, g, s, 600, 5, p);
        check(ok && s.h == rim_before, "a still pond over an uneven bed stays exactly still for ten minutes");
        bool still = true;
        for (const auto q : s.qx) still = still && q == 0;
        for (const auto q : s.qy) still = still && q == 0;
        check(still, "and carries no discharge");
        (void)before;
    }

    std::cout << "dam break (Ritter)\n";
    {
        // A 1 m column released onto a thin film in a flat channel, 2 m cells.
        const double h0 = 1.0, cell = 2.0;
        auto g = grid(400, 5, cell, [](double, double) { return 0.0; });
        auto s = initial_hydrology(g);
        const std::uint32_t dam = 200;
        auto g5 = grid(400, 5, cell, [](double, double) { return 0.0; });
        g = g5;
        s = initial_hydrology(g);
        for (std::uint32_t j = 0; j < 5; ++j)
            for (std::uint32_t i = 0; i < 400; ++i) s.h[g.grid.index(i, j)] = i < dam ? q24(h0) : q24(0.001);
        wall(g, s, 5);
        start(s);
        auto solver = make_cpu_hydrology_solver();
        solver->install(g);
        const double t = 20;
        // Ritter's solution is frictionless.
        auto frictionless = p;
        frictionless.manning_n = 0.001;
        const bool ok = run(*solver, g, s, t, 0.5, frictionless);
        check(ok, "mass is conserved exactly and depths stay non-negative");
        // Ritter (1892): the frictionless rarefaction, tip at 2 sqrt(g h0) t,
        // depth 4/9 h0 at the dam. The local-inertial scheme omits convective
        // acceleration, so it cannot reproduce that supercritical fan: the
        // release travels instead as a bore at about sqrt(g h) of the depth
        // behind it. These checks hold it to that, and record the lag.
        const double ritter_front = 2 * std::sqrt(9.81 * h0) * t;
        std::uint32_t front = dam;
        for (std::uint32_t i = dam; i < 400; ++i)
            if (metres(s.h[g.grid.index(i, 2)]) > 0.01) front = i;
        const double travelled = (front + 0.5 - dam) * cell;
        const double plateau = metres(s.h[g.grid.index(dam + 5, 2)]);
        std::cout << "      front travelled " << travelled << " m (Ritter " << ritter_front << " m, "
                  << std::lround(100 * travelled / ritter_front) << "%); depth behind it " << plateau << " m\n";
        check(near(travelled / t, std::sqrt(9.81 * plateau), 0.25 * std::sqrt(9.81 * plateau)),
              "the release travels as a bore at sqrt(g h) of the depth behind it");
        check(travelled > 0.3 * ritter_front && travelled < ritter_front, "trailing Ritter's frictionless tip, as an inertial scheme must");
        bool monotone = true;
        for (std::uint32_t i = 150; i + 1 < 399; ++i) monotone = monotone && s.h[g.grid.index(i + 1, 2)] <= s.h[g.grid.index(i, 2)] + q24(0.002);
        check(monotone, "the profile falls monotonically from the reservoir to the front: no checkerboard oscillation");
        detect_hotspots(g, s);
        check(s.max_froude > 0.5 && s.supercritical_cells > 0 && !s.hotspots.empty(), "the supercritical front is flagged as where the approximation is weakest");
        check(near(metres(s.h[g.grid.index(180, 2)]), 0.77, 0.25), "the drawdown reaches back into the reservoir");
    }

    std::cout << "water on a slope (scenario A, no drains)\n";
    {
        // A 3% plane falling eastwards; a pond released at the top.
        auto g = grid(60, 10, 5, [](double x, double) { return 10 - 0.03 * x; });
        auto s = initial_hydrology(g);
        for (std::uint32_t j = 3; j < 7; ++j)
            for (std::uint32_t i = 2; i < 8; ++i) s.h[g.grid.index(i, j)] = q24(0.3);
        start(s);
        const auto centroid = [&] {
            double m = 0, mx = 0;
            for (std::uint32_t j = 0; j < 10; ++j)
                for (std::uint32_t i = 0; i < 60; ++i) {
                    m += s.h[g.grid.index(i, j)];
                    mx += s.h[g.grid.index(i, j)] * g.grid.centre_x(i);
                }
            return m > 0 ? mx / m : 0.0;
        };
        const double x0 = centroid();
        auto solver = make_cpu_hydrology_solver();
        solver->install(g);
        bool ok = run(*solver, g, s, 120, 5, p);
        const double x1 = centroid();
        check(ok && x1 > x0 + 50, "water runs downhill");
        ok = run(*solver, g, s, 1800, 5, p) && ok;
        check(ok && s.ledger.boundary > 0, "and leaves the district at the low edge");
        check(s.ledger.boundary + s.stored == s.ledger.initial, "everything that left is accounted for");
    }

    std::cout << "basin (a closed depression keeps its water)\n";
    {
        // A bowl 3 m deep at the centre; 30 minutes of 40 mm/h rain, then an hour of nothing.
        auto g = grid(40, 40, 10, [](double x, double y) {
            const double dx = x - 200, dy = y - 200;
            return 3.0 * std::min(1.0, (dx * dx + dy * dy) / (180.0 * 180.0));
        });
        auto s = initial_hydrology(g);
        wall(g, s, 4);
        start(s);
        auto solver = make_cpu_hydrology_solver();
        solver->install(g);
        const auto rain = [&](int) {
            HydrologySources src;
            src.rain.assign(g.cells(), static_cast<std::int32_t>(std::floor(0.040 / 3600 * 5 * kQ24)));
            // Nothing falls on the wall itself, which would run straight off the edge.
            for (std::uint32_t j = 0; j < 40; ++j)
                for (std::uint32_t i = 0; i < 40; ++i)
                    if (i == 0 || j == 0 || i == 39 || j == 39) src.rain[g.grid.index(i, j)] = 0;
            return src;
        };
        bool ok = run(*solver, g, s, 1800, 5, p, rain);
        const auto rained = s.ledger.rain;
        const auto lowest = g.grid.index(20, 20);
        ok = run(*solver, g, s, 1800, 5, p) && ok;
        const auto settled = s.stored;
        const auto boundary_then = s.ledger.boundary;
        ok = run(*solver, g, s, 1800, 5, p) && ok;
        check(ok, "mass is conserved exactly through rain and settling");
        check(s.stored == rained && s.ledger.boundary == 0, "every drop of the rain is still held in the walled bowl");
        check(s.stored == settled && s.ledger.boundary == boundary_then, "once settled, the pond neither drains nor evaporates away by itself");
        detect_hotspots(g, s);
        check(s.max_froude < 0.5 && s.hotspots.empty(), "a settled pond is subcritical, with nothing flagged");
        const auto deepest = std::max_element(s.h.begin(), s.h.end()) - s.h.begin();
        const auto [di, dj] = std::pair{deepest % 40, deepest / 40};
        check(std::abs(int(di) - 20) <= 1 && std::abs(int(dj) - 20) <= 1 && s.h[lowest] > q24(0.05), "the deepest water is at the bottom of the bowl");
        // The pond's surface is level: depth + bed is the same across wet cells.
        double lo = 1e9, hi = -1e9;
        for (std::size_t k = 0; k < g.cells(); ++k)
            if (s.h[k] > q24(0.01)) {
                const double eta = metres(s.h[k]) + g.z_q16[k] / 65536.0;
                lo = std::min(lo, eta);
                hi = std::max(hi, eta);
            }
        check(hi - lo < 0.02, "and its surface is level");
    }

    std::cout << "positivity and sinks\n";
    {
        // Rough terrain, torrential rain, open water in one corner, an absurdly long step.
        auto g = grid(32, 32, 4, [](double x, double y) { return std::fmod(x * 7.3 + y * 3.1, 2.0); });
        for (std::uint32_t j = 0; j < 4; ++j)
            for (std::uint32_t i = 0; i < 4; ++i) g.flags[g.grid.index(i, j)] = 1;
        for (std::size_t k = 0; k < g.cells(); ++k) g.infiltration_m_s[k] = k % 3 == 0 ? float(10.0 / 3.6e6) : 0.0f;
        auto s = initial_hydrology(g);
        start(s);
        auto solver = make_cpu_hydrology_solver();
        solver->install(g);
        auto rough = p;
        rough.max_substeps = 4;  // force steps far beyond the CFL limit
        const auto storm = [&](int n) {
            HydrologySources src;
            src.rain.assign(g.cells(), n < 60 ? q24(0.2 / 3600 * 30) : 0);
            src.evaporation.assign(g.cells(), q24(0.001 / 3600 * 30));
            src.infiltration.resize(g.cells());
            for (std::size_t k = 0; k < g.cells(); ++k) src.infiltration[k] = static_cast<std::int32_t>(g.infiltration_m_s[k] * 30 * kQ24);
            return src;
        };
        const bool ok = run(*solver, g, s, 3600, 30, rough, storm);
        check(ok, "no cell ever goes negative, and the ledger balances every step, even beyond the CFL limit");
        check(s.ledger.sea > 0 && s.ledger.infiltrated > 0 && s.ledger.evaporated > 0, "open water, infiltration and evaporation all take water");
        for (const auto v : s.h) check(std::isfinite(double(v)), "finite");
        const auto deep = hydrology_substeps(5, 25, q24(2.0), p), shallow = hydrology_substeps(5, 25, q24(0.01), p);
        check(deep.substeps >= shallow.substeps && deep.dt_s * std::sqrt(9.81 * 2.0) <= p.cfl * 25 + 1e-9, "deeper water takes shorter steps, within the CFL bound");
        check(hydrology_substeps(5, 1, q24(80), p).capped, "an impossible step is flagged as capped");
    }

    std::cout << "determinism\n";
    {
        auto g = grid(20, 20, 8, [](double x, double y) { return 0.01 * x + 0.02 * std::sin(y); });
        auto a = initial_hydrology(g), b = a;
        a.h[g.grid.index(10, 10)] = b.h[g.grid.index(10, 10)] = q24(1.5);
        start(a);
        start(b);
        auto sa = make_cpu_hydrology_solver(), sb = make_cpu_hydrology_solver();
        sa->install(g);
        sb->install(g);
        run(*sa, g, a, 300, 5, p);
        run(*sb, g, b, 300, 5, p);
        check(a.h == b.h && a.qx == b.qx && a.qy == b.qy && a.ledger.boundary == b.ledger.boundary, "two runs give the same bits");
    }

    std::cout << "the runtime: rain over terrain\n";
    {
        ScenarioConfig c;
        c.playback_duration_s = 600;
        c.grid_width = 7;
        c.grid_height = 7;
        c.day = 0;
        c.month = 7;
        c.environment.dem_source = "synthetic:valley:12";
        const auto s = ScenarioCompiler{}.compile(Seed128::parse("0x5eed00000000000000000000000000b1"), c);
        EnvironmentRuntime rt;
        rt.install(s);
        const auto& g = rt.terrain().grid;
        const StormCell storm{g.origin_x_m + g.width * g.cell_m / 2, g.origin_y_m + g.height * g.cell_m / 2, 2000, 1.0};
        for (std::uint32_t t = 1; t <= 3600; ++t) {
            EnvironmentInputs in;
            in.virtual_s = 12 * 3600 + t;
            if (t <= 1800) in.storms = {storm};
            rt.step(in);
        }
        const auto& w = rt.state().water;
        check(w.ledger.rain > 0 && w.ledger.expected() == w.stored, "rain falls and the ledger balances");
        // A valley along x = centre: the floor is wetter than the slopes.
        const auto mid = g.width / 2;
        double floor = 0, slopes = 0;
        for (std::uint32_t j = 0; j < g.height; ++j) {
            floor += w.h[g.index(mid, j)];
            slopes += w.h[g.index(0, j)] + w.h[g.index(g.width - 1, j)];
        }
        check(floor > slopes, "water collects along the valley floor");
        std::int32_t valley_road = 0, slope_road = 0;
        for (std::size_t e = 0; e < s.edges.size(); ++e) {
            const auto& a = s.nodes[s.edges[e].from.value].position;
            const double dx = std::abs(a.x_m - storm.x_m);
            if (dx < g.cell_m) valley_road = std::max(valley_road, w.road_max[e]);
            if (dx > 4 * g.cell_m) slope_road = std::max(slope_road, w.road_max[e]);
        }
        check(valley_road > slope_road, "roads on the valley floor stand in deeper water than roads on its sides");
        check(rt.summary()["hydrology"]["conservation_error_m3"].get<double>() == 0.0, "the reported conservation error is zero");
        const auto* depth = rt.field("water_depth");
        check(depth && depth->size() == g.cells() && *std::max_element(depth->begin(), depth->end()) > 0, "the water depth field is published");
    }

    std::cout << "replay through the engine\n";
    {
        const auto dir = std::filesystem::temp_directory_path() / "dstns-hydrology-test";
        std::filesystem::remove_all(dir);
        {
            RuntimeLogger logger(dir);
            SimulationEngine engine(logger);
            ScenarioConfig c;
            c.playback_duration_s = 600;
            c.grid_width = 6;
            c.grid_height = 6;
            c.dws_frequency = 3;
            c.environment.dem_source = "synthetic:bowl:6";
            engine.prepare(Seed128::parse("0x5eed00000000000000000000000000b2"), c);
            // Run through the whole day so the storms have fallen, then
            // compare a mid-day state reached directly and by rewinding.
            std::uint32_t wettest = 0;
            double most = -1;
            for (std::uint32_t t = 3600; t <= 86400; t += 3600) {
                engine.seek(t, false);
                const auto stored = engine.environment()["data"]["state"]["hydrology"]["stored_m3"].get<double>();
                if (stored > most) { most = stored; wettest = t; }
            }
            check(most > 0, "the scheduled storms put water on the ground");
            engine.seek(wettest - 1234, false);
            const auto direct = engine.environment()["data"]["state"]["hydrology"];
            const auto field = engine.field("water_depth", 64)["data"]["values"];
            engine.seek(wettest - 4000, false);
            engine.seek(wettest - 1234, false);
            check(engine.environment()["data"]["state"]["hydrology"] == direct, "rewinding and replaying reproduces the water exactly");
            check(engine.field("water_depth", 64)["data"]["values"] == field, "and its depth field");
            engine.terminate();
        }
        std::filesystem::remove_all(dir);
    }

    if (failures) {
        std::cerr << failures << " hydrology check(s) failed\n";
        return 1;
    }
    std::cout << "hydrology tests passed\n";
    return 0;
}
