// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Dynamic Fastboot's pointer and selection policies: a prepared seed is offered only to a run under the policy and
// extent it was prepared for, and a pointer from before policies existed counts as urban-crfg-v3 over every city.
#include "dstns/core-ng/selection.hpp"
#include "dstns/next_world.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <vector>
#include <stdexcept>
#include <string>

using namespace dstns;
using nlohmann::json;

namespace {
void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}
} // namespace

int main() {
    try {
        const auto cache = std::filesystem::temp_directory_path() / "dstns-next-world-ng";
        std::filesystem::remove_all(cache);
        std::filesystem::create_directories(cache);
        std::filesystem::copy_file("data/fixtures/real_network.osm.xml", cache / "berlin_x5000.osm.xml");

        ScenarioConfig legacy;
        legacy.osm_file = "auto";
        legacy.map_cache_dir = cache.string();
        legacy.engine = core_ng::kEngineId;
        ScenarioConfig berlin = legacy;
        berlin.map_selection_version = core_ng::kGeoPolicy;
        berlin.map_selection_mode = "fixed_city";
        berlin.map_cities = {"berlin"};
        const auto describe = core_ng::hooks().describe;
        const auto locate_in = [](const ScenarioConfig& config) {
            return [config](Seed128 seed) { return core_ng::select_location(seed, core_ng::policy_of(config), config.map_city_extent_m); };
        };

        // A seed whose city under urban-crfg-v3 is not Berlin: under the fixed-city policy it is a Berlin world.
        Seed128 prepared = Seed128::from_decimal("1");
        for (int i = 2; select_map_location(prepared).city == "Berlin"; ++i) prepared = Seed128::from_decimal(std::to_string(i));
        const auto write = [&](const json& pointer) { std::ofstream(NextWorld::pointer(cache)) << pointer.dump(); };
        const json base = {{"seed", prepared.decimal()}, {"city", "Berlin"}, {"key", "berlin_x5000"}, {"extent_m", 5000.0}, {"state", "ready"}};

        // matches(): policy and extent, whichever engine described the policy.
        auto geo_pointer = base;
        geo_pointer["format"] = 2;
        geo_pointer["selection"] = describe(berlin);
        check(NextWorld::matches(geo_pointer, 5000.0, describe(berlin)), "the same policy matches");
        auto without_fingerprint = describe(berlin);
        without_fingerprint.erase("fingerprint");
        check(NextWorld::matches(geo_pointer, 5000.0, without_fingerprint), "the fingerprint follows from the policy");
        check(!NextWorld::matches(geo_pointer, 8000.0, describe(berlin)), "another extent does not match");
        check(!NextWorld::matches(geo_pointer, 5000.0, describe(legacy)), "urban-crfg-v3 does not take a fixed-city seed");
        auto munich = berlin;
        munich.map_cities = {"munich"};
        check(!NextWorld::matches(geo_pointer, 5000.0, describe(munich)), "another city does not match");
        check(NextWorld::matches(base, 5000.0, describe(legacy)), "an old pointer is urban-crfg-v3");
        check(NextWorld::matches(base, 5000.0, json{{"policy", "urban-crfg-v3"}, {"mode", "global"}}), "as core-legacy describes it");
        check(!NextWorld::matches(base, 5000.0, describe(berlin)), "an old pointer is not for a filtered run");

        // take(): the prepared seed only for its own policy.
        NextWorld next;
        write(geo_pointer);
        check(next.take(berlin, locate_in(berlin), describe(berlin)) == prepared, "a fixed-city run takes its prepared seed");
        const auto other = next.take(legacy, locate_in(legacy), describe(legacy));
        check(other != prepared, "a legacy run never takes a fixed-city seed");
        check(!other || select_map_location(*other).city == "Berlin", "it takes a seed for a city already here, if any");
        write(base);
        check(next.take(legacy, locate_in(legacy), describe(legacy)) == prepared, "a legacy run takes an old pointer's seed");
        const auto filtered = next.take(berlin, locate_in(berlin), describe(berlin));
        check(filtered != prepared && (!filtered || locate_in(berlin)(*filtered).city == "Berlin"), "a filtered run does not take an old pointer's seed");

        check(!next.take(berlin, locate_in(berlin), describe(berlin), {"Berlin"}), "a city this session has shown is not offered again");

        // A session's new worlds: never a city already shown while the policy has another, then round again.
        const NextWorld::Locate locate3 = [](Seed128 seed) {
            MapLocation where;
            where.city = std::vector<std::string>{"Berlin", "Munich", "Hamburg"}[(seed.decimal().back() - '0') % 3];
            return where;
        };
        std::set<std::string> seen;
        std::string current = locate3(Seed128::from_decimal("7")).city;
        seen.insert(current);
        for (int i = 0; i < 2; ++i) {
            const auto [seed, gave_up] = seed_avoiding(seen, current, locate3);
            current = locate3(seed).city;
            check(!gave_up && seen.insert(current).second, "repeated " + current + " before the policy ran out");
        }
        const auto [again, gave_up] = seed_avoiding(seen, current, locate3);
        check(gave_up && locate3(again).city != current, "with every city shown, somewhere other than here");

        std::filesystem::remove_all(cache);
        std::cout << "[next-world-ng] prepared seeds are offered only under their own policy and extent\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
