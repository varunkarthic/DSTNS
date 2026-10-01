// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/model.hpp"

#include <filesystem>
#include <functional>

namespace dstns {

class ScenarioCompiler {
public:
    // What compilation is doing, reported as it moves between stages so the
    // interface can say where a wait is being spent. "selecting" resolves the
    // seed to a place, "acquiring" obtains that place's map (a cached tile
    // passes straight through), "building" constructs the graph, signals and
    // schedules.
    enum class Stage { Selecting, Acquiring, Building };
    using Progress = std::function<void(Stage)>;

    [[nodiscard]] Scenario compile(Seed128 seed, const ScenarioConfig& config, const Progress& progress = {}) const;
    void export_sumo(const Scenario& scenario, const std::filesystem::path& directory) const;
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
