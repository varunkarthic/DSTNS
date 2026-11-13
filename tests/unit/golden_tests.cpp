// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Golden fixtures: frozen results that every later release must reproduce exactly.
// - urban-crfg-v3 seed -> city, country and anchor (bit-exact doubles);
// - compile hashes for a grid and the bundled OSM district (the same on every platform);
// - the full runtime snapshot at 03:25:45, per platform: physics calls sin and exp, which macOS and Linux may
//   round differently in the last bit (see docs/concepts/reproducibility.md, "Floating-point caveat").
//   A platform with no recorded value fails, so a new one is recorded deliberately.
// A difference fails the test. To record new values deliberately (a new algorithm version), run with
// DSTNS_GOLDEN_WRITE=1 and say why in CHANGELOG.md.
#include "dstns/core-ng/selection.hpp"
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
#include <tuple>
#include <vector>

using namespace dstns;
using nlohmann::json;

namespace {
const char* kFixture = "tests/fixtures/golden.json";

std::string platform() {
#if defined(__APPLE__)
    std::string os = "darwin";
#elif defined(__linux__)
    std::string os = "linux";
#else
    std::string os = "other";
#endif
#if defined(__aarch64__)
    return os + "-arm64";
#elif defined(__x86_64__)
    return os + "-x86_64";
#else
    return os + "-other";
#endif
}

// %a prints a double exactly, so the comparison is bit for bit.
std::string exact(double value) {
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%a", value);
    return buffer;
}

std::string snapshot_hash(const Seed128& seed, const ScenarioConfig& cfg, const std::string& label) {
    const bool ng = cfg.engine == core_ng::kEngineId;
    const auto directory = std::filesystem::temp_directory_path() / ("dstns-golden-" + label);
    std::filesystem::remove_all(directory);
    std::string hash;
    {
        RuntimeLogger logger(directory);
        SimulationEngine engine(logger);
        if (ng) engine.register_engine(core_ng::kEngineId, core_ng::hooks());
        engine.prepare(seed, cfg);
        engine.seek(12'345, false);
        hash = sha256(engine.snapshot()["data"].dump());
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(directory);
    return hash;
}

// Every value, as one engine computes it. Both engines must give the same.
json actual(const std::string& engine) {
    const bool ng = engine == core_ng::kEngineId;
    json out;
    out["map_selection_version"] = "urban-crfg-v3";
    out["catalogue_size"] = city_catalog().size();
    std::vector<std::string> seeds{"0", "1", "2", "3", "7", "25", "42", "99", "382923", "18446744073709551615",
                                   "340282366920938463463374607431768211455"};
    for (int i = 100; i < 164; ++i) seeds.push_back(std::to_string(i * 7919));
    for (const auto& text : seeds) {
        const auto seed = Seed128::from_decimal(text);
        const auto location = ng ? core_ng::select_location(seed, core_ng::SelectionPolicy{}, 5000.0) : select_map_location(seed);
        out["selection"][text] = {{"city", location.city}, {"country", location.country},
                                  {"anchor_lat", exact(location.anchor_lat)}, {"anchor_lon", exact(location.anchor_lon)},
                                  {"cache_key", location.cache_key()}};
    }

    // urban-geo-v1, frozen from 3.2.0: a core-ng policy, the same whichever engine asks.
    for (const auto& [name, mode, countries, cities] : std::vector<std::tuple<std::string, std::string, std::vector<std::string>, std::vector<std::string>>>{
             {"countries-IN", "countries", {"IN"}, {}}, {"countries-AE-SA-TR", "countries", {"AE", "SA", "TR"}, {}},
             {"cities-istanbul-mumbai", "cities", {}, {"istanbul", "mumbai"}}, {"fixed_city-mumbai", "fixed_city", {}, {"mumbai"}}}) {
        ScenarioConfig policy_config;
        policy_config.map_selection_version = core_ng::kGeoPolicy;
        policy_config.map_selection_mode = mode;
        policy_config.map_countries = countries;
        policy_config.map_cities = cities;
        const auto policy = core_ng::policy_of(policy_config);
        out["selection_geo_v1"][name]["fingerprint"] = policy.fingerprint();
        for (const auto* text : {"7", "42", "382923", "18446744073709551615"}) {
            const auto location = core_ng::select_location(Seed128::from_decimal(text), policy, 5000.0);
            out["selection_geo_v1"][name][text] = {{"city", location.city}, {"anchor_lat", exact(location.anchor_lat)},
                                                   {"anchor_lon", exact(location.anchor_lon)}};
        }
    }

    ScenarioConfig grid;
    grid.grid_width = 7; grid.grid_height = 7; grid.dws_frequency = 4; grid.playback_duration_s = 600;
    ScenarioConfig osm = grid;
    osm.osm_file = "tests/fixtures/roads.osm.xml"; osm.max_nodes = 50;
    // "auto": the seed chooses the city and anchor. The bundled district is planted in a private cache under each
    // seed's city name, so the whole path from seed to district runs offline.
    ScenarioConfig automatic = osm;
    automatic.osm_file = "auto";
    automatic.max_nodes = 50000;
    automatic.map_cache_dir = (std::filesystem::temp_directory_path() / ("dstns-golden-cache-" + engine)).string();
    std::filesystem::remove_all(automatic.map_cache_dir);
    std::filesystem::create_directories(automatic.map_cache_dir);
    for (const auto* text : {"42", "382923"})
        std::filesystem::copy_file("data/fixtures/real_network.osm.xml", select_map_location(Seed128::from_decimal(text)).cache_path(automatic.map_cache_dir),
                                   std::filesystem::copy_options::overwrite_existing);
    const ScenarioCompiler compiler;
    const auto hooks = ng ? core_ng::hooks() : ScenarioCompiler::Hooks{};
    for (auto [label, cfg] : std::vector<std::pair<std::string, ScenarioConfig>>{{"grid", grid}, {"osm", osm}, {"auto", automatic}}) {
        cfg.engine = engine;
        for (const auto* text : {"42", "382923"}) {
            const auto seed = Seed128::from_decimal(text);
            const auto s = compiler.compile(seed, cfg, {}, hooks);
            out["scenario"][label][text] = {{"map_hash", s.map_hash}, {"graph_hash", s.graph_hash},
                                            {"event_hash", s.event_hash}, {"scenario_hash", s.scenario_hash},
                                            {"snapshot_12345", {{platform(), snapshot_hash(seed, cfg, label + "-" + text)}}}};
        }
    }
    std::filesystem::remove_all(automatic.map_cache_dir);
    return out;
}
} // namespace

int main() {
    try {
        auto now = actual("core-legacy");
        json frozen;
        if (std::ifstream in(kFixture); in) frozen = json::parse(in);
        if (const char* write = std::getenv("DSTNS_GOLDEN_WRITE"); write && std::string(write) == "1") {
            // Keep the other platforms' snapshots; replace this platform's.
            if (frozen.contains("scenario"))
                for (auto& [label, seeds] : now["scenario"].items())
                    for (auto& [seed, entry] : seeds.items())
                        if (frozen["scenario"].contains(label) && frozen["scenario"][label].contains(seed))
                            for (auto& [key, value] : frozen["scenario"][label][seed]["snapshot_12345"].items())
                                if (!key.empty() && key != platform()) entry["snapshot_12345"][key] = value;
            std::ofstream(kFixture) << now.dump(2) << "\n";
            std::cout << "[golden] wrote " << kFixture << "\n";
            return 0;
        }
        if (frozen.is_null()) throw std::runtime_error(std::string("missing ") + kFixture);
        // Compare this platform's snapshots only; the rest must match exactly.
        std::vector<std::string> missing;
        for (auto& [label, seeds] : frozen["scenario"].items())
            for (auto& [seed, entry] : seeds.items()) {
                auto& snapshots = entry["snapshot_12345"];
                if (!snapshots.contains(platform())) {
                    missing.push_back("/scenario/" + label + "/" + seed + " computes " +
                                      now["scenario"][label][seed]["snapshot_12345"][platform()].dump());
                    continue;
                }
                snapshots = json{{platform(), snapshots[platform()]}};
            }
        if (!missing.empty()) {
            for (const auto& line : missing) std::cerr << line << "\n";
            throw std::runtime_error("no golden snapshot recorded for " + platform() + " (values above)");
        }
        // core-ng must give exactly what core-legacy recorded.
        for (const auto& [engine, result] : {std::pair{std::string("core-legacy"), now},
                                             std::pair{std::string(core_ng::kEngineId), actual(core_ng::kEngineId)}}) {
            if (result != frozen) {
                for (const auto& entry : json::diff(frozen, result)) std::cerr << engine << ": " << entry.dump() << "\n";
                throw std::runtime_error(engine + " differs from the golden fixtures");
            }
        }
        std::cout << "[golden] core-legacy and core-ng: seed selection, compile hashes and runtime snapshots match\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
