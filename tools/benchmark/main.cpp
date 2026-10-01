// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/engine.hpp"
#include "dstns/graph.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>

int main(int argc, char** argv) {
    std::size_t grid_dim = (argc >= 2) ? std::stoul(argv[1]) : 20; // 20x20 = 400 nodes, 1500+ edges
    std::cout << "DSTNS Benchmark Tool (grid: " << grid_dim << "x" << grid_dim << ")\n";

    dstns::ScenarioConfig cfg;
    cfg.grid_width = grid_dim;
    cfg.grid_height = grid_dim;
    cfg.playback_duration_s = 600;
    cfg.dws_frequency = 5;

    auto seed = dstns::Seed128::parse("0xCAFEBABE0123456789ABCDEF00000001");

    auto t0 = std::chrono::steady_clock::now();
    dstns::ScenarioCompiler compiler;
    auto scenario = compiler.compile(seed, cfg);
    auto t1 = std::chrono::steady_clock::now();
    auto compile_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    std::cout << "Compiled " << scenario.nodes.size() << " nodes, " << scenario.edges.size()
              << " edges in " << compile_ms << " ms\n";

    // Benchmark GraphStore & Routing
    dstns::GraphStore store(scenario);
    dstns::RoutePlanner planner(store);

    t0 = std::chrono::steady_clock::now();
    std::size_t routes_found = 0;
    for (std::uint32_t i = 0; i < std::min<std::size_t>(scenario.nodes.size(), 100); ++i) {
        for (std::uint32_t j = 0; j < std::min<std::size_t>(scenario.nodes.size(), 10); ++j) {
            auto res = planner.route(dstns::NodeId{i}, dstns::NodeId{j});
            if (res.found) ++routes_found;
        }
    }
    t1 = std::chrono::steady_clock::now();
    auto route_us = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
    std::cout << "Computed 1,000 A* routes in " << route_us << " us (" << (route_us / 1000.0) << " us/route)\n";

    // Benchmark Snapshot serialization
    auto temp = std::filesystem::temp_directory_path() / "dstns-bench-logs";
    std::filesystem::remove_all(temp);
    {
        dstns::RuntimeLogger logger(temp);
        dstns::SimulationEngine engine(logger);
        engine.start(seed, cfg);
        t0 = std::chrono::steady_clock::now();
        for (int step = 0; step < 100; ++step) {
            auto snap = engine.snapshot();
            (void)snap;
        }
        t1 = std::chrono::steady_clock::now();
        auto snap_us = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
        std::cout << "Generated 100 dynamic snapshots in " << snap_us << " us (" << (snap_us / 100.0) << " us/snapshot)\n";
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(temp);

    std::cout << "Benchmark completed successfully.\n";
    return 0;
}
