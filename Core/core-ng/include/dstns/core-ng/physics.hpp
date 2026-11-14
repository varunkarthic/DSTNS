// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/physics.hpp"

namespace dstns::core_ng {
// One physics tick of a world core-ng compiled: EngineHooks::step.
void physics_step(physics::Context& ctx, std::uint32_t dt);
// Its checkpoints: EngineHooks::capture and ::rewind.
void capture_checkpoint(physics::TimelineContext& ctx);
void rewind_to_checkpoint(physics::TimelineContext& ctx, std::uint32_t target);
} // namespace dstns::core_ng
