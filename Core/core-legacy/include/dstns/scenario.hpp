// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/geo.hpp"
#include "dstns/model.hpp"

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>

namespace dstns {
namespace physics { struct Context; struct TimelineContext; }

class ScenarioCompiler {
public:
    // What compilation is doing, reported as it moves between stages so the
    // interface can say where a wait is being spent. "selecting" resolves the
    // seed to a place, "acquiring" obtains that place's map (a cached tile
    // passes straight through), "building" constructs the graph, signals and
    // schedules.
    enum class Stage { Selecting, Acquiring, Building };
    using Progress = std::function<void(Stage)>;
    // Seams through which core-ng takes over one stage at a time. An empty hook keeps core-legacy's own code, so a
    // compile without hooks is exactly the 3.0 compile.
    struct Hooks {
        // Resolves the seed to a place when the map is "auto". It also validates the selection policy.
        std::function<MapLocation(Seed128, const ScenarioConfig&)> select;
        // Checks the selection policy before anything starts; throws std::invalid_argument.
        std::function<void(const ScenarioConfig&)> validate;
        // The selection policy as the manifest reports it, with its fingerprint.
        std::function<nlohmann::json(const ScenarioConfig&)> describe;
        // Compiles the whole scenario in place of core-legacy's compiler.
        std::function<Scenario(Seed128, const ScenarioConfig&, const Progress&)> compile;
        // Advances a world compiled by this engine by one physics tick, in place of core-legacy's (physics::step).
        std::function<void(physics::Context&, std::uint32_t)> step;
        // Keeps a checkpoint, and goes back to one, for worlds this engine compiled (physics::capture, physics::rewind).
        std::function<void(physics::TimelineContext&)> capture;
        std::function<void(physics::TimelineContext&, std::uint32_t)> rewind;
    };

    [[nodiscard]] Scenario compile(Seed128 seed, const ScenarioConfig& config, const Progress& progress = {},
                                   const Hooks& hooks = {}) const;
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
