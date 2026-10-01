// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/engine.hpp"
#include "dstns/graph.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <filesystem>
#include <iostream>
#include <numeric>
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
                assert_true(is_source_direction_allowed(scenario.edges[stop.edge.value]), "Bus stop edge direction is traversable");
                assert_true(stop.position_m >= 0.0, "Bus stop position >= 0");
                assert_true(stop.position_m <= scenario.edges[stop.edge.value].length_m, "Bus stop position within edge length");
            }

            for (const auto& trip : scenario.trips) {
                for (const auto edge : trip.route) {
                    assert_true(is_source_direction_allowed(scenario.edges[edge.value]), "Planned trip excludes forbidden source direction");
                }
            }

            for (const auto& signal : scenario.signals) {
                assert_true(signal.phases_s.size() == 6, "Signal plan has two green/yellow/all-red groups");
                const auto allocated = std::accumulate(signal.phases_s.begin(), signal.phases_s.end(), std::uint32_t{0});
                assert_true(allocated <= signal.cycle_s, "Signal phase durations fit within cycle");
            }

            // Invariant 3: Weather events must have valid spatial/temporal bounds
            for (const auto& dws : scenario.dws_events) {
                assert_true(dws.epicenter.value < scenario.nodes.size(), "DWS epicenter in node bounds");
                assert_true(dws.radius_m > 0.0, "DWS radius positive");
                assert_true(dws.intensity >= 0.0 && dws.intensity <= 1.0, "DWS intensity clamped in [0,1]");
                assert_true(dws.end_ppm >= dws.start_ppm, "DWS end >= start");
            }

            // Invariant 4: Incidents must have valid topological anchors and parameters
            for (const auto& inc : scenario.incidents) {
                assert_true(inc.edge.value < scenario.edges.size(), "Incident edge in bounds");
                assert_true(is_source_direction_allowed(scenario.edges[inc.edge.value]), "Incident edge traversable");
                assert_true(inc.node.value < scenario.nodes.size(), "Incident node in bounds");
                assert_true(inc.end_virtual_s > inc.start_virtual_s, "Incident end > start");
                assert_true(inc.speed_multiplier >= 0.0 && inc.speed_multiplier <= 1.0, "Incident speed multiplier in [0,1]");
                assert_true(inc.capacity_multiplier >= 0.0 && inc.capacity_multiplier <= 1.0, "Incident capacity multiplier in [0,1]");
            }

            GraphStore routed_graph(scenario);
            for (const auto& edge : scenario.edges) {
                if (is_source_direction_allowed(edge) && edge.id.value % 7 == 0) routed_graph.edge_state(edge.id).closed = true;
            }
            RoutePlanner planner(routed_graph);
            for (const auto& from : scenario.nodes) {
                for (const auto& to : scenario.nodes) {
                    const auto route = planner.route(from.id, to.id);
                    for (const auto edge : route.edges) {
                        assert_true(!routed_graph.edge_states()[edge.value].closed, "Route excludes dynamically closed edge");
                        assert_true(is_source_direction_allowed(scenario.edges[edge.value]), "Route excludes forbidden source direction");
                    }
                }
            }

            const auto runtime_dir = std::filesystem::temp_directory_path() / ("dstns-property-day-" + std::to_string(day));
            std::filesystem::remove_all(runtime_dir);
            {
                RuntimeLogger logger(runtime_dir);
                SimulationEngine engine(logger);
                engine.prepare(seed, cfg);
                engine.seek(43'210, false);
                const auto snapshot = engine.snapshot();
                const auto bounded = [](double value) { return std::isfinite(value) && value >= 0.0 && value <= 1.0; };
                assert_true(bounded(snapshot["clock"]["simulation_percentage"]), "Simulation percentage clamped in [0,1]");
                for (const auto& node : snapshot["data"]["nodes"]) {
                    assert_true(bounded(node["rainfall"]), "Dynamic node rainfall clamped in [0,1]");
                    assert_true(bounded(node["flood"]), "Dynamic node flood clamped in [0,1]");
                    assert_true(bounded(node["building_effect"]), "Dynamic building effect clamped in [0,1]");
                }
                for (const auto& edge : snapshot["data"]["edges"]) {
                    const auto id = edge["id"].get<std::size_t>();
                    assert_true(bounded(edge["congestion"]), "Dynamic edge congestion clamped in [0,1]");
                    assert_true(bounded(edge["rainfall"]), "Dynamic edge rainfall clamped in [0,1]");
                    assert_true(bounded(edge["flood"]), "Dynamic edge flood clamped in [0,1]");
                    assert_true(edge["effective_speed_mps"].get<double>() >= 0.0, "Effective speed is non-negative");
                    assert_true(edge["effective_speed_mps"].get<double>() <= scenario.edges[id].free_speed_mps, "Effective speed does not exceed free speed");
                }
                engine.stop();
                engine.terminate();
            }
            std::filesystem::remove_all(runtime_dir);
        }

        std::cout << "[property-tests] All property tests passed successfully.\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
