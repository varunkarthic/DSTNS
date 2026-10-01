// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/engine.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
nlohmann::json run_snapshot(const dstns::Seed128& seed, const dstns::ScenarioConfig& cfg, const std::string& label) {
    const auto directory = std::filesystem::temp_directory_path() / ("dstns-replay-test-" + label);
    std::filesystem::remove_all(directory);
    nlohmann::json snapshot;
    {
        dstns::RuntimeLogger logger(directory);
        dstns::SimulationEngine engine(logger);
        engine.prepare(seed, cfg);
        engine.seek(12'345, false);
        snapshot = engine.snapshot()["data"];
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(directory);
    return snapshot;
}

void verify_config(const dstns::Seed128& seed, const dstns::ScenarioConfig& cfg, const std::string& label) {
    dstns::ScenarioCompiler compiler;
    const auto first = compiler.compile(seed, cfg);
    const auto second = compiler.compile(seed, cfg);
    if (first.graph_hash != second.graph_hash) throw std::runtime_error(label + " graph hash diverged");
    if (first.scenario_hash != second.scenario_hash) throw std::runtime_error(label + " scenario hash diverged");
    if (first.event_hash != second.event_hash) throw std::runtime_error(label + " event hash diverged");
    if (run_snapshot(seed, cfg, label + "-first") != run_snapshot(seed, cfg, label + "-second")) {
        throw std::runtime_error(label + " engine snapshots diverged at fixed virtual time");
    }
}
}

int main() {
    try {
        using namespace dstns;
        std::cout << "[replay-tests] Testing cross-run deterministic reproducibility...\n";

        auto seed = Seed128::parse("0xFEEDFACECAFED00D123456789ABCDEF0");

        ScenarioConfig cfg;
        cfg.grid_width = 7;
        cfg.grid_height = 7;
        cfg.dws_frequency = 4;
        cfg.playback_duration_s = 600;

        verify_config(seed, cfg, "grid");
        cfg.osm_file = "tests/fixtures/roads.osm.xml";
        cfg.max_nodes = 50;
        verify_config(seed, cfg, "osm");

        std::cout << "[replay-tests] Grid and OSM engine-state reproducibility passed.\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
