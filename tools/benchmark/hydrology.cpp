// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// dstns_benchmark hydrology: the surface-water step on the CPU and on Vulkan
// across grid sizes, with water everywhere (the worst case: no dry cells to
// skip), to find where the device starts to pay for its submission cost.

#include "dstns/environment/hydrology.hpp"

#include <chrono>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace dstns;
using namespace dstns::env;

namespace {
double time_steps(HydrologySolver& solver, const HydrologyGrid& g, HydrologyState s, int steps) {
    const HydrologyParams p;
    solver.upload(s);
    const auto sub = hydrology_substeps(5, g.grid.cell_m, s.h_max, p);
    HydrologySources src;
    solver.advance(s, src, sub.dt_s, sub.substeps, p);  // warm
    const auto t0 = std::chrono::steady_clock::now();
    for (int n = 0; n < steps; ++n) solver.advance(s, src, sub.dt_s, sub.substeps, p);
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / steps;
}
} // namespace

int hydrology_benchmark(int argc, char** argv) {
    std::vector<std::uint32_t> sides{64, 128, 256, 512, 1024};
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--sides" && i + 1 < argc) {
            sides.clear();
            std::stringstream list(argv[++i]);
            for (std::string item; std::getline(list, item, ',');) sides.push_back(static_cast<std::uint32_t>(std::stoul(item)));
        } else {
            std::cout << "dstns_benchmark hydrology [--sides N,N,...]\n";
            return a == "--help" ? 0 : 2;
        }
    }
    compute::ComputeOptions options;
    std::string reason;
    auto gpu = make_vulkan_hydrology_solver(options, {}, reason);
    std::cout << "Surface water, one 5 s step with water on every cell (25 m cells)\n";
    if (!gpu) std::cout << "Vulkan unavailable: " << reason << "\n";
    for (const auto side : sides) {
        HydrologyGrid g;
        g.grid = {0, 0, 25, side, side};
        g.z_q16.resize(g.cells());
        g.flags.assign(g.cells(), 0);
        g.pervious.assign(g.cells(), 0);
        g.infiltration_m_s.assign(g.cells(), 0);
        for (std::uint32_t j = 0; j < side; ++j)
            for (std::uint32_t i = 0; i < side; ++i)
                g.z_q16[g.grid.index(i, j)] = static_cast<std::int32_t>(std::llround((0.002 * i + 0.3 * std::sin(j * 0.1)) * 65536));
        g.road_offsets = {0};
        auto s = initial_hydrology(g);
        for (auto& h : s.h) h = static_cast<std::int32_t>(0.3 * kQ24);
        for (const auto v : s.h) s.stored += v;
        s.ledger.initial = s.stored;
        s.h_max = static_cast<std::int64_t>(0.3 * kQ24);
        const int steps = side >= 512 ? 5 : 20;
        auto cpu = make_cpu_hydrology_solver();
        cpu->install(g);
        const double c = time_steps(*cpu, g, s, steps);
        std::cout << std::setw(5) << side << " x " << std::setw(5) << side << " (" << std::setw(8) << g.cells() << " cells)  CPU "
                  << std::fixed << std::setprecision(2) << std::setw(8) << c << " ms";
        if (gpu) {
            gpu->install(g);
            const double v = time_steps(*gpu, g, s, steps);
            std::cout << "  Vulkan " << std::setw(8) << v << " ms  speedup " << std::setprecision(2) << c / v << "x";
        }
        std::cout << '\n';
    }
    return 0;
}
