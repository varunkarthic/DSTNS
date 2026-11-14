// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// core-ng map selection: which city and anchor a seed resolves to, under an explicit, versioned policy.
// A seed is not a reversible place lookup: a run is identified by its seed together with its policy.
//
//   urban-crfg-v3  the frozen legacy policy: every city in the catalogue, exactly as engine 3.0 chose.
//   urban-geo-v1   opt-in: the operator narrows the catalogue to countries or cities, or fixes one city. The
//                  eligible cities keep the catalogue's order, and one bounded draw picks among them. With mode
//                  "global" it chooses exactly what urban-crfg-v3 chooses. Countries and cities may also be left
//                  out (exclude_countries, exclude_cities) of whatever the mode allows; a policy with none left out
//                  has the same fingerprint as before exclusions existed.
//   urban-geo-v2   urban-geo-v1's rules over a larger catalogue (world_catalog(): the same 181 cities, then more), the
//                  launcher's policy on core-ng. Its draws differ from urban-crfg-v3's, since there are more cities.

#include "dstns/geo.hpp"
#include "dstns/model.hpp"
#include "dstns/engine_hooks.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace dstns::core_ng {

inline constexpr const char* kEngineId = "core-ng";
inline constexpr const char* kLegacyPolicy = "urban-crfg-v3";
inline constexpr const char* kGeoPolicy = "urban-geo-v1";
// urban-geo-v1's rules over world_catalog(): the 181 cities and more after them.
inline constexpr const char* kGeoPolicyV2 = "urban-geo-v2";

struct SelectionPolicy {
    std::string id{kLegacyPolicy};
    std::string mode{"global"};                  // global | countries | cities | fixed_city
    std::vector<std::string> countries, cities;  // canonical IDs, sorted and unique
    std::vector<std::string> exclude_countries, exclude_cities;
    // The canonical text the fingerprint is taken of. Equal policies have equal text.
    [[nodiscard]] std::string canonical() const;
    // "sha256:" and the SHA-256 of canonical().
    [[nodiscard]] std::string fingerprint() const;
    [[nodiscard]] nlohmann::json to_json() const;
};

// Canonical IDs: a country's ISO 3166-1 alpha-2 code ("IN"), a city's slug ("mumbai").
[[nodiscard]] std::string country_id(const City& city);
[[nodiscard]] std::string city_id(const City& city);

// The policy a configuration asks for, normalised and checked. Throws std::invalid_argument with an operator-facing
// message for an unknown policy or mode, an unknown ID, or a choice that leaves no city.
[[nodiscard]] SelectionPolicy policy_of(const ScenarioConfig& config);

// The cities a policy allows, in catalogue order.
[[nodiscard]] std::vector<const City*> eligible(const SelectionPolicy& policy);

// The cities a policy draws from: world_catalog() for urban-geo-v2, city_catalog() otherwise.
[[nodiscard]] const std::vector<City>& catalogue(const std::string& policy);

// Resolve a seed under a policy.
[[nodiscard]] MapLocation select_location(Seed128 seed, const SelectionPolicy& policy, double extent_m);

// The hooks that route the legacy compiler through core-ng's modules.
[[nodiscard]] EngineHooks hooks();

} // namespace dstns::core_ng
