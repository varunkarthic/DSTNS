// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// What an engine gives the runtime host (SimulationEngine): how it selects a place, checks and describes its selection
// policy, compiles a world, advances it one tick, and keeps and restores checkpoints. The host has no engine of its
// own: every engine, core-legacy and core-ng alike, registers these (Core/engines/src/engines.cpp).
#pragma once

#include "dstns/geo.hpp"
#include "dstns/model.hpp"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <functional>

namespace dstns {
namespace physics { struct Context; struct TimelineContext; }

// What compiling is doing: "selecting" resolves the seed to a place, "acquiring" obtains that place's map (a cached
// one passes straight through), "building" constructs the graph, signals and schedules.
enum class CompileStage { Selecting, Acquiring, Building };
using CompileProgress = std::function<void(CompileStage)>;

struct EngineHooks {
    // Resolves the seed to a place when the map is "auto".
    std::function<MapLocation(Seed128, const ScenarioConfig&)> select;
    // Checks the selection policy before anything starts; throws std::invalid_argument.
    std::function<void(const ScenarioConfig&)> validate;
    // The selection policy as the manifest reports it, with its fingerprint where it has one.
    std::function<nlohmann::json(const ScenarioConfig&)> describe;
    // Compiles the whole scenario.
    std::function<Scenario(Seed128, const ScenarioConfig&, const CompileProgress&)> compile;
    // Advances a world this engine compiled by one physics tick.
    std::function<void(physics::Context&, std::uint32_t)> step;
    // Keeps a checkpoint, and goes back to one.
    std::function<void(physics::TimelineContext&)> capture;
    std::function<void(physics::TimelineContext&, std::uint32_t)> rewind;
};

} // namespace dstns
