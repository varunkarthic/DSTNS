// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/engines.hpp"

#include "dstns/core-legacy/legacy.hpp"
#include "dstns/core-ng/identity.hpp"
#include "dstns/core-ng/lifecycle.hpp"
#include "dstns/core-ng/selection.hpp"
#include "dstns/core-ng/world.hpp"

namespace dstns {

void install_engines(SimulationEngine& engine) {
    engine.register_engine(core_ng::kEngineId, core_ng::hooks(), core_ng::identity());
    engine.register_engine(core_legacy::kEngineId, core_legacy::hooks(), core_legacy::identity());
    engine.set_transition_guard(core_ng::lifecycle::allowed);
    engine.set_world_guard(core_ng::world::allowed);
}

} // namespace dstns
