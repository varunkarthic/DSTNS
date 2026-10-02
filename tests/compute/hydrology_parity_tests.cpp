// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The surface-water solver on Vulkan against the CPU reference: the same
// problems, step by step, compared bit for bit (fields, ledger, statistics
// and road summaries). Exit 77 (skipped) when no Vulkan device is available.
#include "dstns/environment/hydrology.hpp"
#include "dstns/environment/runtime.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
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

std::int32_t q24(double m) { return static_cast<std::int32_t>(std::llround(m * kQ24)); }

HydrologyGrid make_grid(std::uint32_t w, std::uint32_t h, double cell) {
    HydrologyGrid g;
    g.grid = {0, 0, cell, w, h};
    g.z_q16.resize(g.cells());
    g.flags.assign(g.cells(), 0);
    g.pervious.assign(g.cells(), 0);
    g.infiltration_m_s.assign(g.cells(), 0);
    for (std::uint32_t j = 0; j < h; ++j)
        for (std::uint32_t i = 0; i < w; ++i) {
            const double z = 2.0 + 0.02 * i - 0.01 * j + 0.4 * std::sin(i * 0.37) * std::cos(j * 0.23);
            g.z_q16[g.grid.index(i, j)] = static_cast<std::int32_t>(std::llround(z * 65536));
        }
    for (std::uint32_t j = 0; j < 5; ++j)
        for (std::uint32_t i = w - 6; i < w; ++i) g.flags[g.grid.index(i, j)] = 1;  // a corner of open water
    // Roads: a few rows and columns of cells.
    g.road_offsets = {0};
    for (std::uint32_t r = 0; r < 12; ++r) {
        for (std::uint32_t k = 0; k < w; k += 2) g.road_cells.push_back(static_cast<std::uint32_t>(g.grid.index(k, (r * 7) % h)));
        g.road_offsets.push_back(static_cast<std::uint32_t>(g.road_cells.size()));
    }
    return g;
}

bool same(const HydrologyState& a, const HydrologyState& b) {
    return a.ledger.rain == b.ledger.rain && a.ledger.boundary == b.ledger.boundary && a.ledger.sea == b.ledger.sea &&
           a.ledger.evaporated == b.ledger.evaporated && a.ledger.infiltrated == b.ledger.infiltrated && a.stored == b.stored &&
           a.h_max == b.h_max && a.wet_cells == b.wet_cells && a.flooded_cells == b.flooded_cells && a.road_max == b.road_max &&
           a.road_mean == b.road_mean;
}
} // namespace

int main() {
    compute::ComputeOptions options;
    options.allow_software_vulkan = true;
    std::string reason;
    auto gpu = make_vulkan_hydrology_solver(options, {}, reason);
    if (!gpu) {
        std::cout << "skipped: no Vulkan device (" << reason << ")\n";
        return 77;
    }
    std::cout << "device: " << gpu->name() << '\n';

    for (const auto& [w, h, cell] : {std::tuple{37u, 23u, 5.0}, std::tuple{96u, 64u, 10.0}}) {
        std::cout << "grid " << w << " x " << h << '\n';
        auto g = make_grid(w, h, cell);
        for (std::size_t k = 0; k < g.cells(); k += 3) g.infiltration_m_s[k] = float(10.0 / 3.6e6);
        auto cpu = make_cpu_hydrology_solver();
        cpu->install(g);
        gpu->install(g);
        auto a = initial_hydrology(g), b = a;
        // A column of water to release, then rain, sinks and a long dry tail.
        for (std::uint32_t j = h / 3; j < h / 2; ++j)
            for (std::uint32_t i = 2; i < w / 4; ++i) a.h[g.grid.index(i, j)] = b.h[g.grid.index(i, j)] = q24(0.8);
        for (const auto v : a.h) a.stored += v;
        b.stored = a.stored;
        a.ledger.initial = b.ledger.initial = a.stored;
        a.h_max = b.h_max = q24(0.8);
        cpu->upload(a);
        gpu->upload(b);
        HydrologyParams p;
        bool lockstep = true;
        for (int step = 0; step < 240; ++step) {
            HydrologySources src;
            if (step < 120) {
                src.rain.resize(g.cells());
                for (std::size_t k = 0; k < g.cells(); ++k) src.rain[k] = static_cast<std::int32_t>((k * 7919 + step * 31) % 400);
            }
            if (step % 3 == 0) {
                src.evaporation.assign(g.cells(), 3);
                src.infiltration.resize(g.cells());
                for (std::size_t k = 0; k < g.cells(); ++k) src.infiltration[k] = static_cast<std::int32_t>(g.infiltration_m_s[k] * 5 * kQ24);
            }
            const auto sub = hydrology_substeps(5, cell, a.h_max, p);
            cpu->advance(a, src, sub.dt_s, sub.substeps, p);
            gpu->advance(b, src, sub.dt_s, sub.substeps, p);
            lockstep = lockstep && same(a, b);
        }
        check(lockstep, "ledger, statistics and road summaries agree after every one of 240 steps");
        gpu->download(b);
        check(a.h == b.h, "depths are bit-identical");
        check(a.qx == b.qx && a.qy == b.qy, "discharges are bit-identical");
        check(a.ledger.expected() == a.stored && b.ledger.expected() == b.stored, "both ledgers balance exactly");
        check(a.ledger.sea > 0 && a.ledger.boundary > 0 && a.ledger.infiltrated > 0, "every route out of the grid was exercised");
        // Round trip: a state uploaded to the device comes back unchanged.
        auto c = a;
        gpu->upload(c);
        auto d = initial_hydrology(g);
        gpu->download(d);
        check(d.h == c.h && d.qx == c.qx && d.qy == c.qy, "upload and download round-trip exactly");
    }

    std::cout << "the whole environment, CPU against Vulkan\n";
    {
        ScenarioConfig c;
        c.playback_duration_s = 600;
        c.grid_width = 8;
        c.grid_height = 8;
        c.day = 0;
        c.month = 8;
        c.environment.dem_source = "synthetic:bowl:7";
        c.environment.grid_cell_m = 10;
        const auto scenario = ScenarioCompiler{}.compile(Seed128::parse("0x5eed00000000000000000000000000c1"), c);
        EnvironmentCompute on_cpu, on_gpu;
        on_cpu.options.backend = compute::BackendPreference::Cpu;
        on_gpu.options.backend = compute::BackendPreference::Vulkan;
        on_gpu.options.allow_software_vulkan = true;
        EnvironmentRuntime a, b;
        a.install(scenario, {}, {}, &on_cpu);
        b.install(scenario, {}, {}, &on_gpu);
        check(a.summary()["hydrology"]["solver"] == "cpu" && b.summary()["hydrology"]["solver"].get<std::string>().rfind("vulkan", 0) == 0,
              "one runtime on each backend");
        const auto& g = a.terrain().grid;
        const StormCell storm{g.origin_x_m + g.width * g.cell_m * 0.4, g.origin_y_m + g.height * g.cell_m * 0.6, 900, 0.9};
        bool lockstep = true;
        for (std::uint32_t t = 1; t <= 4 * 3600; ++t) {
            EnvironmentInputs in;
            in.virtual_s = 11 * 3600 + t;
            if (t <= 5400) in.storms = {storm};
            a.step(in);
            b.step(in);
            if (t % 600 == 0) {
                // Everything but the solver's own name.
                auto x = a.summary(), y = b.summary();
                x["hydrology"].erase("solver");
                y["hydrology"].erase("solver");
                lockstep = lockstep && x == y;
            }
        }
        check(lockstep, "every ten minutes the summaries agree exactly (water ledger, peaks, Froude, Sun, surface)");
        const auto& sa = a.state();
        const auto& sb = b.state();
        check(sa.water.h == sb.water.h && sa.water.qx == sb.water.qx && sa.water.qy == sb.water.qy, "water fields are bit-identical");
        check(sa.surface_temperature_c == sb.surface_temperature_c, "surface temperatures, cooled by evaporation, are bit-identical");
        check(sa.water.ledger.rain > 0 && sa.water.ledger.evaporated > 0, "the storm rained and the water evaporated");
        // A checkpoint taken from the device restores onto the CPU, and back.
        const auto saved = b.state();
        a.restore(saved);
        check(a.state().water.h == saved.water.h, "a device checkpoint restores on the CPU");
    }

    if (failures) {
        std::cerr << failures << " hydrology parity check(s) failed\n";
        return 1;
    }
    std::cout << "hydrology parity tests passed\n";
    return 0;
}
