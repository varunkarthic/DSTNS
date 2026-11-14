// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng as it describes itself. Its version is its own, apart from the build's: it counts the migration's releases
// (docs/design/v3-core-ng-migration.md). Beta from 0.8.0, when it came to own every computation of a run; stable and the default from 1.0.0.
#pragma once

#include "dstns/engine.hpp"

namespace dstns::core_ng {

inline constexpr const char* kVersion = "1.0.0";

inline EngineIdentity identity() {
    EngineIdentity out;
    out.version = kVersion;
    out.kind = "real";
    // Stable and the default since 1.0.0 (#22): it owns every computation of a run, with results identical to
    // core-legacy's on every fixture and platform. The runtime host (lifecycle, clock, operator commands and their
    // undo, the HTTP API) is SimulationEngine, shared by every engine by design.
    out.channel = "stable";
    out.owns = {"world selection (urban-crfg-v3, urban-geo-v1)", "scenario compilation", "physics step", "checkpoints and seeking", "lifecycle table", "world-job table"};
    out.shared = {"runtime host: operator commands and undo, the HTTP API (engine-neutral)"};
    out.changes = {
        "1.0.0 (stable): the default engine. Every world is the same as core-legacy would make, seed for seed.",
        "0.9.0: checkpoints are kept deflated, losslessly: a day's take about an eighth of the memory, with the same state restored.",
        "0.8.0 (beta): checkpoints are kept and restored by core-ng's own code; seeking back gives the same state as core-legacy.",
        "0.7.0: worlds advance by core-ng's own physics tick, identical to core-legacy's to the last bit.",
        "0.6.0: worlds are compiled by core-ng's own compiler, identical to core-legacy's to the last bit.",
        "0.5.0: the world job is checked against core-ng's table; three faults fixed.",
        "0.4.0: Dynamic Fastboot records the selection policy of the world it prepared.",
        "0.3.0: every lifecycle transition is checked against core-ng's table; four faults fixed.",
        "0.2.0: urban-geo-v1: worlds limited to chosen countries or cities.",
    };
    return out;
}

} // namespace dstns::core_ng
