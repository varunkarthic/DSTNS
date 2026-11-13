// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's scenario compile: validate, select, acquire, build the district, then each planning module.
// Ported from core-legacy's ScenarioCompiler with every expression unchanged, so results are identical to the
// last bit: the golden fixtures check it on both engines.

#include "dstns/core-ng/compile.hpp"
#include "dstns/core-ng/selection.hpp"
#include "dstns/geo.hpp"
#include "dstns/osm.hpp"
#include "dstns/osm_fetch.hpp"

#include <stdexcept>

namespace dstns::core_ng {

Scenario compile(Seed128 seed_value, const ScenarioConfig &config, const ScenarioCompiler::Progress &progress) {
    using Stage = ScenarioCompiler::Stage;
    const auto report = [&](Stage stage) {
        if (progress)
            progress(stage);
    };
    // Checked first, so an invalid policy is refused before anything is read or fetched.
    const auto policy = policy_of(config);
    if (config.max_nodes < 2 || config.max_nodes > 50000)
        throw std::invalid_argument("max_nodes must be in [2,50000]");
    if (config.day < -1 || config.day > 1)
        throw std::invalid_argument("invalid day type");
    if (config.demand_bin_virtual_s == 0 || config.demand_bin_virtual_s > 86400)
        throw std::invalid_argument("invalid demand bin");
    if (config.playback_duration_s < 60 || config.playback_duration_s > 3600)
        throw std::invalid_argument("playback_duration_s must be in [60,3600]");
    auto effective_config = config;
    if (!(effective_config.tick_rate > 0 && effective_config.tick_rate <= kMaxTickRate))
        throw std::invalid_argument("tick_rate must be in (0,10]");
    // "auto" means: let the seed choose a real place and fetch it on demand.
    // The tile is cached under its seed-derived name, so re-running one seed is
    // offline and free while a re-rolled seed necessarily downloads a new map.
    MapLocation location{};
    bool located = false, downloaded = false;
    if (effective_config.osm_file == "auto") {
        report(Stage::Selecting);
        location = select_location(seed_value, policy, effective_config.map_city_extent_m);
        located = true;
        report(Stage::Acquiring);
        const auto tile = acquire_map_tile(location, effective_config.map_cache_dir);
        effective_config.osm_file = tile.file.string();
        downloaded = tile.downloaded;
    }
    if (effective_config.osm_file.empty() &&
        (effective_config.grid_width < 3 || effective_config.grid_height < 3 ||
         std::uint64_t(effective_config.grid_width) * effective_config.grid_height > effective_config.max_nodes))
        throw std::invalid_argument("invalid grid dimensions or max_nodes");
    if (effective_config.dws_frequency > 0 &&
        std::uint64_t(effective_config.dws_frequency - 1) * 5 >= effective_config.playback_duration_s)
        throw std::invalid_argument("DWS frequency violates five-playback-second spacing");
    report(Stage::Building);
    Scenario s;
    s.seed = seed_value;
    s.config = effective_config;

    // Cryptographically derived domain-separated sub-seeds
    const auto map_seed = seed_value.derive("map");
    const auto dws_seed = seed_value.derive("dws");
    const auto traffic_seed = seed_value.derive("traffic");
    const auto incident_seed = seed_value.derive("incidents");
    const auto scenario_seed = seed_value.derive("scenario");

    DeterministicRng map_rng(map_seed);
    DeterministicRng dws_rng(dws_seed);
    DeterministicRng traffic_rng(traffic_seed);
    DeterministicRng incident_rng(incident_seed);
    DeterministicRng scenario_rng(scenario_seed);

    if (s.config.day < 0)
        s.config.day = 0;
    if (s.config.day > 1)
        throw std::invalid_argument("day must be 0, 1, or auto");
    if (effective_config.osm_file.empty()) {
        plan::grid(s, map_rng);
        s.map_hash = "sha256:" + sha256("dstns/offline-road-fixture/v1");
    } else {
        DistrictAnchor district{};
        if (located) {
            district.valid = true;
            district.lat = location.anchor_lat;
            district.lon = location.anchor_lon;
            district.target_nodes = effective_config.map_district_nodes;
        }
        auto road = OsmRoadLoader{}.load_xml(effective_config.osm_file, effective_config.max_nodes, map_rng, district);
        s.root = road.root;
        s.nodes = std::move(road.nodes);
        s.edges = std::move(road.edges);
        s.map_hash = std::move(road.source_hash);
        s.features = std::move(road.features);
        s.projection_lat = road.projection_lat;
        s.projection_lon = road.projection_lon;
        s.map_source_file = effective_config.osm_file;
        if (located) {
            s.map_city = location.city;
            s.map_country = location.country;
            s.map_anchor_lat = location.anchor_lat;
            s.map_anchor_lon = location.anchor_lon;
            s.map_city_extent_m = location.extent_m;
            s.map_downloaded = downloaded;
            // No part of this tile has a road network large enough to simulate. Say
            // so plainly instead of running a degenerate scenario that looks like a
            // working one.
            if (s.nodes.size() < kMinimumDistrictNodes) {
                throw MapFetchError(
                    "The map tile for " + location.city + " (" + location.country + ") at " +
                    std::to_string(location.anchor_lat) + ", " + std::to_string(location.anchor_lon) +
                    " has no connected road network large enough to simulate: the largest near it has " +
                    std::to_string(s.nodes.size()) + " junctions, and at least " +
                    std::to_string(kMinimumDistrictNodes) + " are needed. Choose a different seed.");
            }
        }
    }
    plan::bus_stops(s);
    if (effective_config.buildings && effective_config.osm_file.empty())
        plan::buildings(s, scenario_rng);
    if (effective_config.osm_file.empty())
        for (const auto &n : s.nodes)
            if (n.building) {
                MapFeature f;
                f.id = "fixture/" + std::to_string(n.id.value);
                f.category = to_string(*n.building);
                f.name = "Synthetic " + f.category;
                f.center = n.position;
                f.geometry = {n.position};
                f.demand_type = n.building;
                f.anchor = n.id;
                s.features.push_back(f);
            }
    if (effective_config.signals)
        plan::signals(s);
    if (effective_config.traffic) {
        plan::hotspots(s, traffic_rng);
        plan::trips(s, traffic_rng);
    }
    if (effective_config.dws)
        plan::weather(s, dws_rng);
    if (effective_config.incidents)
        plan::incidents(s, incident_rng);
    plan::hashes(s);
    return s;
}

} // namespace dstns::core_ng
