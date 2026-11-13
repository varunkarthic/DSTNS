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

#include "dstns/geo.hpp"
#include "dstns/model.hpp"
#include "dstns/scenario.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace dstns::core_ng {

inline constexpr const char* kEngineId = "core-ng";
inline constexpr const char* kLegacyPolicy = "urban-crfg-v3";
inline constexpr const char* kGeoPolicy = "urban-geo-v1";

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

// Resolve a seed under a policy.
[[nodiscard]] MapLocation select_location(Seed128 seed, const SelectionPolicy& policy, double extent_m);

// The hooks that route the legacy compiler through core-ng's modules.
[[nodiscard]] ScenarioCompiler::Hooks hooks();

} // namespace dstns::core_ng
