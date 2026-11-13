// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/core-ng/selection.hpp"

#include <stdexcept>

namespace dstns::core_ng {

std::string SelectionPolicy::canonical() const { return "policy=" + id; }

std::string SelectionPolicy::fingerprint() const { return "sha256:" + sha256(canonical()); }

SelectionPolicy policy_of(const ScenarioConfig& config) {
    if (config.map_selection_version != kLegacyPolicy) throw std::invalid_argument("unsupported map selection version");
    return SelectionPolicy{config.map_selection_version};
}

MapLocation select_location(Seed128 seed, const SelectionPolicy& policy, double extent_m) {
    if (policy.id != kLegacyPolicy) throw std::invalid_argument("unsupported map selection version");
    // The legacy policy is frozen: its catalogue, order and draws belong to core-legacy and are reused unchanged.
    return select_map_location(seed, extent_m);
}

ScenarioCompiler::Hooks hooks() {
    ScenarioCompiler::Hooks out;
    out.select = [](Seed128 seed, const ScenarioConfig& config) {
        return select_location(seed, policy_of(config), config.map_city_extent_m);
    };
    return out;
}

} // namespace dstns::core_ng
