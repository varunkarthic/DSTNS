// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Golden fixtures: frozen results that every later release must reproduce exactly.
// - urban-crfg-v3 seed -> city, country and anchor (bit-exact doubles);
// - compile hashes and the full runtime snapshot at 03:25:45 for a grid and the bundled OSM district.
// A difference fails the test. To record new values deliberately (a new algorithm version), run with
// DSTNS_GOLDEN_WRITE=1 and say why in CHANGELOG.md.
#include "dstns/engine.hpp"
#include "dstns/geo.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using namespace dstns;
using nlohmann::json;

namespace {
const char* kFixture = "tests/fixtures/golden.json";

// %a prints a double exactly, so the comparison is bit for bit.
std::string exact(double value) {
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%a", value);
    return buffer;
}

std::string snapshot_hash(const Seed128& seed, const ScenarioConfig& cfg, const std::string& label) {
    const auto directory = std::filesystem::temp_directory_path() / ("dstns-golden-" + label);
    std::filesystem::remove_all(directory);
    std::string hash;
    {
        RuntimeLogger logger(directory);
        SimulationEngine engine(logger);
        engine.prepare(seed, cfg);
        engine.seek(12'345, false);
        hash = sha256(engine.snapshot()["data"].dump());
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(directory);
    return hash;
}

json actual() {
    json out;
    out["map_selection_version"] = "urban-crfg-v3";
    out["catalogue_size"] = city_catalog().size();
    std::vector<std::string> seeds{"0", "1", "2", "3", "7", "25", "42", "99", "382923", "18446744073709551615",
                                   "340282366920938463463374607431768211455"};
    for (int i = 100; i < 164; ++i) seeds.push_back(std::to_string(i * 7919));
    for (const auto& text : seeds) {
        const auto location = select_map_location(Seed128::from_decimal(text));
        out["selection"][text] = {{"city", location.city}, {"country", location.country},
                                  {"anchor_lat", exact(location.anchor_lat)}, {"anchor_lon", exact(location.anchor_lon)},
                                  {"cache_key", location.cache_key()}};
    }

    ScenarioConfig grid;
    grid.grid_width = 7; grid.grid_height = 7; grid.dws_frequency = 4; grid.playback_duration_s = 600;
    ScenarioConfig osm = grid;
    osm.osm_file = "tests/fixtures/roads.osm.xml"; osm.max_nodes = 50;
    const ScenarioCompiler compiler;
    for (const auto& [label, cfg] : std::vector<std::pair<std::string, ScenarioConfig>>{{"grid", grid}, {"osm", osm}}) {
        for (const auto* text : {"42", "382923"}) {
            const auto seed = Seed128::from_decimal(text);
            const auto s = compiler.compile(seed, cfg);
            out["scenario"][label][text] = {{"map_hash", s.map_hash}, {"graph_hash", s.graph_hash},
                                            {"event_hash", s.event_hash}, {"scenario_hash", s.scenario_hash},
                                            {"snapshot_12345", snapshot_hash(seed, cfg, label + "-" + text)}};
        }
    }
    return out;
}
} // namespace

int main() {
    try {
        const auto now = actual();
        if (const char* write = std::getenv("DSTNS_GOLDEN_WRITE"); write && std::string(write) == "1") {
            std::ofstream(kFixture) << now.dump(2) << "\n";
            std::cout << "[golden] wrote " << kFixture << "\n";
            return 0;
        }
        std::ifstream in(kFixture);
        if (!in) throw std::runtime_error(std::string("missing ") + kFixture);
        const auto frozen = json::parse(in);
        if (now != frozen) {
            for (const auto& entry : json::diff(frozen, now)) std::cerr << entry.dump() << "\n";
            throw std::runtime_error("results differ from the golden fixtures");
        }
        std::cout << "[golden] seed selection, compile hashes and runtime snapshots match\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
