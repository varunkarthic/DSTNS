#include "dstns/engine.hpp"
#include "dstns/graph.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>

namespace {
void assert_true(bool cond, const std::string& msg) {
    if (!cond) throw std::runtime_error("Property test failure: " + msg);
}
}

int main() {
    try {
        using namespace dstns;
        std::cout << "[property-tests] Running property invariance checks...\n";

        ScenarioCompiler compiler;
        auto seed = Seed128::parse("0xABCD1234EF567890ABCD1234EF567890");

        for (int day : {0, 1}) {
            ScenarioConfig cfg;
            cfg.day = day;
            cfg.grid_width = 6;
            cfg.grid_height = 6;
            cfg.dws_frequency = 4;

            auto scenario = compiler.compile(seed, cfg);

            // Invariant 1: Edge endpoints must exist
            for (const auto& e : scenario.edges) {
                assert_true(e.from.value < scenario.nodes.size(), "Edge 'from' node within bounds");
                assert_true(e.to.value < scenario.nodes.size(), "Edge 'to' node within bounds");
                assert_true(e.length_m > 0.0, "Edge length must be strictly positive");
                assert_true(e.free_speed_mps > 0.0, "Free-flow speed must be strictly positive");
                assert_true(e.base_capacity_vph > 0.0, "Base capacity must be strictly positive");
                assert_true(e.reverse_twin.value < scenario.edges.size(), "Reverse twin must be valid index");
                assert_true(scenario.edges[e.reverse_twin.value].reverse_twin == e.id, "Reverse twin must be reciprocal");
            }

            // Invariant 2: Bus stops must map to valid edges
            for (const auto& stop : scenario.bus_stops) {
                assert_true(stop.edge.value < scenario.edges.size(), "Bus stop edge index in bounds");
                assert_true(stop.position_m >= 0.0, "Bus stop position >= 0");
                assert_true(stop.position_m <= scenario.edges[stop.edge.value].length_m, "Bus stop position within edge length");
            }

            // Invariant 3: Weather events must have valid spatial/temporal bounds
            for (const auto& dws : scenario.dws_events) {
                assert_true(dws.epicenter.value < scenario.nodes.size(), "DWS epicenter in node bounds");
                assert_true(dws.radius_m > 0.0, "DWS radius positive");
                assert_true(dws.intensity >= 0.0 && dws.intensity <= 1.0, "DWS intensity clamped in [0,1]");
                assert_true(dws.end_ppm >= dws.start_ppm, "DWS end >= start");
            }
        }

        std::cout << "[property-tests] All property tests passed successfully.\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
