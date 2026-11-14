// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/core-legacy/legacy.hpp"

#include "dstns/scenario.hpp"

#include <stdexcept>

namespace dstns::core_legacy {

EngineHooks hooks() {
    EngineHooks out;
    // urban-crfg-v3 over every city, the frozen policy (dstns/geo.hpp), and nothing else.
    out.select = [](Seed128 seed, const ScenarioConfig& config) { return select_map_location(seed, config.map_city_extent_m); };
    out.validate = [](const ScenarioConfig& config) {
        if (config.map_selection_version != "urban-crfg-v3" || config.map_selection_mode != "global" || !config.map_countries.empty() || !config.map_cities.empty() ||
            !config.map_exclude_countries.empty() || !config.map_exclude_cities.empty())
            throw std::invalid_argument("core-legacy supports only urban-crfg-v3 over every city; use engine core-ng to choose a policy");
    };
    out.describe = [](const ScenarioConfig& config) {
        return nlohmann::json{{"policy", config.map_selection_version}, {"mode", "global"}, {"countries", nlohmann::json::array()}, {"cities", nlohmann::json::array()}};
    };
    out.compile = [](Seed128 seed, const ScenarioConfig& config, const CompileProgress& progress) { return ScenarioCompiler{}.compile(seed, config, progress); };
    out.step = [](physics::Context& ctx, std::uint32_t dt) { physics::step(ctx, dt); };
    out.capture = [](physics::TimelineContext& ctx) { physics::capture(ctx); };
    out.rewind = [](physics::TimelineContext& ctx, std::uint32_t target) { physics::rewind(ctx, target); };
    return out;
}

EngineIdentity identity() {
    EngineIdentity out;
    out.version = DSTNS_VERSION;
    out.owns = {"world selection (urban-crfg-v3)", "scenario compilation", "physics step", "checkpoints and seeking"};
    out.shared = {"runtime host: operator commands and undo, the HTTP API (engine-neutral)"};
    return out;
}

} // namespace dstns::core_legacy
