// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/engine_hooks.hpp"
#include "dstns/geo.hpp"
#include "dstns/model.hpp"

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>

namespace dstns {

class ScenarioCompiler {
public:
    // The stages, progress and hooks are the host's (dstns/engine_hooks.hpp); these names keep older code reading.
    using Stage = CompileStage;
    using Progress = CompileProgress;
    using Hooks = EngineHooks;

    [[nodiscard]] Scenario compile(Seed128 seed, const ScenarioConfig& config, const Progress& progress = {},
                                   const Hooks& hooks = {}) const;
private:
    void build_canonical_grid(Scenario& scenario, const DeterministicRng& rng) const;
    void place_bus_stops(Scenario& scenario) const;
    void place_buildings(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_signals(Scenario& scenario) const;
    void plan_hotspots(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_trips(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_weather(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_incidents(Scenario& scenario, const DeterministicRng& rng) const;
    void calculate_hashes(Scenario& scenario) const;
};

} // namespace dstns
