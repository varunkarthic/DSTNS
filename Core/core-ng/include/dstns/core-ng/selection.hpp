// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// core-ng map selection: which city and anchor a seed resolves to, under an explicit, versioned policy.
// A seed is not a reversible place lookup; a run is identified by the seed together with its policy.

#include "dstns/geo.hpp"
#include "dstns/model.hpp"
#include "dstns/scenario.hpp"

#include <string>

namespace dstns::core_ng {

inline constexpr const char* kEngineId = "core-ng";
inline constexpr const char* kLegacyPolicy = "urban-crfg-v3";

struct SelectionPolicy {
    std::string id{kLegacyPolicy};
    // The canonical text the fingerprint is taken of. Equal policies have equal text.
    [[nodiscard]] std::string canonical() const;
    // "sha256:" and the SHA-256 of canonical().
    [[nodiscard]] std::string fingerprint() const;
};

// The policy a configuration asks for. Throws std::invalid_argument for one that is not known.
[[nodiscard]] SelectionPolicy policy_of(const ScenarioConfig& config);

// Resolve a seed under a policy. urban-crfg-v3 gives exactly what select_map_location gives.
[[nodiscard]] MapLocation select_location(Seed128 seed, const SelectionPolicy& policy, double extent_m);

// The hooks that route the legacy compiler through core-ng's modules.
[[nodiscard]] ScenarioCompiler::Hooks hooks();

} // namespace dstns::core_ng
