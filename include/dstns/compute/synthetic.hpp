// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Synthetic worlds for benchmarks and backend tests: a road grid of any size,
// beyond the 50,000-node limit of compiled scenarios, with every feature the
// physics step reads (one-way streets, road classes, signals, hotspots,
// storms, incidents). Deterministic in its seed. Not a simulation scenario:
// it has no map, places or trips.

#include "dstns/model.hpp"

#include <cstdint>

namespace dstns::compute {

/// About `nodes` junctions (rounded to a near-square grid) at 120 m spacing.
[[nodiscard]] Scenario synthetic_world(std::uint32_t nodes, std::uint64_t seed = 1);

} // namespace dstns::compute
