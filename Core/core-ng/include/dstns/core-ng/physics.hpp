// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/physics.hpp"

namespace dstns::core_ng {
// One physics tick of a world core-ng compiled: ScenarioCompiler::Hooks::step.
void physics_step(physics::Context& ctx, std::uint32_t dt);
} // namespace dstns::core_ng
