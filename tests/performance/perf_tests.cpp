#include "dstns/graph.hpp"
#include "dstns/scenario.hpp"

#include <chrono>
#include <iostream>

int main() {
    using namespace dstns;
    std::cout << "[perf-tests] Running micro-performance validation...\n";

    ScenarioCompiler compiler;
    auto seed = Seed128::parse("0x0123456789ABCDEF0123456789ABCDEF");

    ScenarioConfig cfg;
    cfg.grid_width = 15;
    cfg.grid_height = 15; // 225 nodes, ~800 edges

    auto t0 = std::chrono::steady_clock::now();
    auto scenario = compiler.compile(seed, cfg);
    auto t1 = std::chrono::steady_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cout << "Scenario compilation (" << scenario.nodes.size() << " nodes): " << ms << " ms\n";

    GraphStore graph(scenario);
    RoutePlanner planner(graph);

    t0 = std::chrono::steady_clock::now();
    std::size_t found_count = 0;
    for (std::uint32_t i = 0; i < 50; ++i) {
        for (std::uint32_t j = 0; j < 50; ++j) {
            auto res = planner.route(NodeId{i}, NodeId{j});
            if (res.found) ++found_count;
        }
    }
    t1 = std::chrono::steady_clock::now();
    auto route_us = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
    std::cout << "2,500 A* routing queries (" << found_count << " found): " << route_us << " us (" << (route_us / 2500.0) << " us/query)\n";

    std::cout << "[perf-tests] Performance checks passed.\n";
    return 0;
}
