// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng map selection: policies, their validation and fingerprints, and their draws.
#include "dstns/core-ng/selection.hpp"

#include <iostream>
#include <set>
#include <stdexcept>
#include <string>

using namespace dstns;
using namespace dstns::core_ng;

namespace {
void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

ScenarioConfig geo(const std::string& mode, std::vector<std::string> countries = {}, std::vector<std::string> cities = {}) {
    ScenarioConfig config;
    config.map_selection_version = kGeoPolicy;
    config.map_selection_mode = mode;
    config.map_countries = std::move(countries);
    config.map_cities = std::move(cities);
    return config;
}

void refuses(const ScenarioConfig& config, const std::string& what) {
    try {
        (void)policy_of(config);
    } catch (const std::invalid_argument&) {
        return;
    }
    throw std::runtime_error("accepted " + what);
}
} // namespace

int main() {
    try {
        // Every catalogue city has a country code and a unique ID.
        std::set<std::string> ids;
        for (const auto& city : city_catalog()) {
            check(country_id(city).size() == 2, "a two-letter code for " + city.country);
            check(ids.insert(city_id(city)).second, "a unique ID for " + city.name);
        }
        check(ids.size() == 181, "181 cities");

        // urban-geo-v1 over every city chooses exactly what urban-crfg-v3 chooses.
        const auto global = policy_of(geo("global"));
        for (std::uint64_t i = 0; i < 500; ++i) {
            const auto seed = Seed128::from_decimal(std::to_string(i * 104729 + 7));
            const auto legacy = select_map_location(seed, 5000.0), ng = select_location(seed, global, 5000.0);
            check(legacy.city == ng.city && legacy.anchor_lat == ng.anchor_lat && legacy.anchor_lon == ng.anchor_lon,
                  "global matches legacy for seed " + seed.decimal());
            const auto legacy_policy = select_location(seed, SelectionPolicy{}, 5000.0);
            check(legacy_policy.city == legacy.city && legacy_policy.anchor_lat == legacy.anchor_lat, "the legacy policy is the legacy function");
        }

        // Countries: only Indian cities, repeatably, spread over several of them.
        const auto india = policy_of(geo("countries", {"in"}));
        std::set<std::string> indian;
        for (std::uint64_t i = 0; i < 300; ++i) {
            const auto seed = Seed128::from_decimal(std::to_string(i + 1));
            const auto place = select_location(seed, india, 5000.0);
            check(place.country == "India", "countries IN chose " + place.country);
            check(place.city == select_location(seed, india, 5000.0).city, "repeatable");
            indian.insert(place.city);
        }
        check(indian.size() == 9, "all nine Indian cities are reachable, got " + std::to_string(indian.size()));

        // Several countries, and a city list: only those, in catalogue order.
        const auto gulf = policy_of(geo("countries", {"SA", "AE", "TR"}));
        const auto allowed = eligible(gulf);
        check(allowed.size() == 7, "seven cities in TR, AE and SA");
        for (std::size_t i = 1; i < allowed.size(); ++i) check(allowed[i - 1] < allowed[i], "eligible cities keep catalogue order");
        const auto pair = policy_of(geo("cities", {}, {"mumbai", "istanbul"}));
        for (std::uint64_t i = 0; i < 100; ++i) {
            const auto city = select_location(Seed128::from_decimal(std::to_string(i)), pair, 5000.0).city;
            check(city == "Mumbai" || city == "Istanbul", "cities chose " + city);
        }

        // A fixed city: always that city, and the seed still chooses the district.
        const auto mumbai = policy_of(geo("fixed_city", {}, {"Mumbai"}));
        std::set<double> anchors;
        for (std::uint64_t i = 0; i < 50; ++i) {
            const auto place = select_location(Seed128::from_decimal(std::to_string(i)), mumbai, 5000.0);
            check(place.city == "Mumbai", "fixed_city chose " + place.city);
            anchors.insert(place.anchor_lat);
        }
        check(anchors.size() == 50, "different seeds give different districts of the fixed city");

        // Fingerprints: normalised, stable, and different for different choices.
        check(policy_of(geo("countries", {" in", "pk", "IN"})).fingerprint() == policy_of(geo("countries", {"PK", "IN"})).fingerprint(),
              "case, spaces, order and repeats do not change the fingerprint");
        check(policy_of(geo("countries", {"PK", "IN"})).canonical() == "policy=urban-geo-v1;mode=countries;countries=IN,PK;cities=",
              "canonical text");
        check(SelectionPolicy{}.fingerprint() == "sha256:" + sha256("policy=urban-crfg-v3;mode=global;countries=;cities="), "legacy fingerprint");
        check(india.fingerprint() != policy_of(geo("countries", {"PK"})).fingerprint(), "different countries, different fingerprints");
        check(global.fingerprint() != SelectionPolicy{}.fingerprint(), "a policy's fingerprint names the policy");

        // Refused, with nothing chosen.
        refuses(geo("anywhere"), "an unknown mode");
        refuses(geo("countries"), "countries without a country");
        refuses(geo("countries", {"XX"}), "an unknown country");
        refuses(geo("countries", {"IN"}, {"mumbai"}), "cities with mode countries");
        refuses(geo("cities", {}, {"atlantis"}), "an unknown city");
        refuses(geo("fixed_city", {}, {"mumbai", "delhi"}), "two fixed cities");
        refuses(geo("global", {"IN"}), "countries with mode global");
        ScenarioConfig legacy_filtered;
        legacy_filtered.map_selection_mode = "countries";
        legacy_filtered.map_countries = {"IN"};
        refuses(legacy_filtered, "filters on urban-crfg-v3");
        ScenarioConfig unknown;
        unknown.map_selection_version = "urban-geo-v9";
        refuses(unknown, "an unknown policy");

        // Exclusions: left out of whatever the mode allows, and named in the fingerprint only when present.
        const auto without = [&](ScenarioConfig config, std::vector<std::string> countries, std::vector<std::string> cities = {}) {
            config.map_exclude_countries = std::move(countries);
            config.map_exclude_cities = std::move(cities);
            return config;
        };
        const auto not_india = policy_of(without(geo("global"), {"in"}));
        check(not_india.canonical() == "policy=urban-geo-v1;mode=global;countries=;cities=;exclude_countries=IN", not_india.canonical());
        check(policy_of(geo("global")).canonical().find("exclude") == std::string::npos, "no exclusion, the fingerprint is as before");
        for (int i = 0; i < 400; ++i)
            check(select_location(Seed128::from_decimal(std::to_string(i * 7919)), not_india, 5000.0).country != "India", "India left out");
        const auto india_not_mumbai = policy_of(without(geo("countries", {"IN"}), {}, {"mumbai"}));
        bool other_indian_city = false;
        for (int i = 0; i < 400; ++i) {
            const auto location = select_location(Seed128::from_decimal(std::to_string(i)), india_not_mumbai, 5000.0);
            check(location.country == "India" && location.city != "Mumbai", "India without Mumbai: " + location.city);
            other_indian_city = true;
        }
        check(other_indian_city && india_not_mumbai.fingerprint() != india.fingerprint(), "an exclusion is a different policy");
        refuses(without(geo("countries", {"IN"}), {"IN"}), "a country both chosen and left out");
        refuses(without(geo("fixed_city", {}, {"mumbai"}), {"AE"}), "a fixed city with exclusions");
        refuses(without(geo("global"), {"XX"}), "an unknown excluded country");
        refuses(without(geo("countries", {"AE"}), {}, {"dubai", "abu-dhabi"}), "an exclusion that leaves no city");
        ScenarioConfig legacy_excluding;
        legacy_excluding.map_exclude_countries = {"IN"};
        refuses(legacy_excluding, "exclusions on urban-crfg-v3");

        // urban-geo-v2: the same 181 cities first, in the same order, then more; each with a code and a unique ID.
        {
            const auto& world = world_catalog();
            check(world.size() > 181, "urban-geo-v2 has more cities");
            std::set<std::string> all;
            for (std::size_t n = 0; n < world.size(); ++n) {
                check(country_id(world[n]).size() == 2, "a two-letter code for " + world[n].country);
                check(all.insert(city_id(world[n])).second, "a unique ID for " + world[n].name);
                if (n < 181) check(city_id(world[n]) == city_id(city_catalog()[n]), "the first 181 in their old order");
            }
            auto v2 = geo("global");
            v2.map_selection_version = kGeoPolicyV2;
            check(eligible(policy_of(v2)).size() == world.size(), "every city under urban-geo-v2 global");
            auto chennai = geo("fixed_city", {}, {"chennai"});
            chennai.map_selection_version = kGeoPolicyV2;
            check(select_location(Seed128::from_decimal("9"), policy_of(chennai), 5000).city == "Chennai", "an old city under urban-geo-v2");
            auto kochi = geo("fixed_city", {}, {"kochi"});
            refuses(kochi, "a new city under urban-geo-v1");
            kochi.map_selection_version = kGeoPolicyV2;
            check(select_location(Seed128::from_decimal("9"), policy_of(kochi), 5000).city == "Kochi", "a new city under urban-geo-v2");
            // urban-geo-v1 keeps its draws: its catalogue did not change.
            check(eligible(policy_of(geo("countries", {"IN"}))).size() == 9, "urban-geo-v1 still has India's nine cities");
        }

        std::cout << "[selection-ng] policies, validation, fingerprints and draws passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
