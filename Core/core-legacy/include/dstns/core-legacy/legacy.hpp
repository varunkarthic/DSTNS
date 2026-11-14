// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-legacy: the engine DSTNS had before core-ng, kept installed and selectable. Its own code is its compiler
// (scenario.cpp), its tick and its checkpoints (physics.cpp); everything else it shares with core-ng (Core/common).
#pragma once

#include "dstns/engine.hpp"
#include "dstns/engine_hooks.hpp"
#include "dstns/physics.hpp"

namespace dstns::core_legacy {

inline constexpr const char* kEngineId = "core-legacy";

[[nodiscard]] EngineHooks hooks();
[[nodiscard]] EngineIdentity identity();

} // namespace dstns::core_legacy

namespace dstns::physics {
// core-legacy's tick, and its checkpoints: keep one of now; go back to the last at or before target (operator edge
// overrides stand), dropping those after it.
void step(Context& ctx, std::uint32_t dt);
void capture(TimelineContext& ctx);
void rewind(TimelineContext& ctx, std::uint32_t target);
} // namespace dstns::physics
