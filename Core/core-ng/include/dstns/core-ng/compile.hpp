// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// core-ng's scenario compile. compile() validates the configuration and the selection policy, resolves the seed to a
// place, acquires its map, grows the district, and then runs each planning module in a fixed order. Every module reads
// and writes one Scenario and draws only from its own sub-seed, so each can be tested and changed alone without
// shifting another's random numbers.
//
//   network.cpp  grid (synthetic districts), bus_stops, buildings
//   plans.cpp    signals, hotspots, trips, weather, incidents, hashes
//   compile.cpp  the order they run in

#include "dstns/model.hpp"
#include "dstns/engine_hooks.hpp"

namespace dstns::core_ng {

[[nodiscard]] Scenario compile(Seed128 seed, const ScenarioConfig& config, const CompileProgress& progress = {});

namespace plan {
void grid(Scenario& scenario, const DeterministicRng& rng);       // sub-seed "map"
void bus_stops(Scenario& scenario);                                // no random numbers
void buildings(Scenario& scenario, const DeterministicRng& rng);  // sub-seed "scenario"; synthetic districts only
void signals(Scenario& scenario);                                  // sub-seed "signals"
void hotspots(Scenario& scenario, const DeterministicRng& rng);   // sub-seed "traffic"
void trips(Scenario& scenario, const DeterministicRng& rng);      // sub-seed "traffic"
void weather(Scenario& scenario, const DeterministicRng& rng);    // sub-seed "dws"
void incidents(Scenario& scenario, const DeterministicRng& rng);  // sub-seed "incidents"
void hashes(Scenario& scenario);                                   // graph, event and scenario hashes
} // namespace plan

} // namespace dstns::core_ng
