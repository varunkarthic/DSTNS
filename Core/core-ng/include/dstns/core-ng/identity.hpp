// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng as it describes itself. Its version is its own, apart from the build's: it counts the migration's releases
// (docs/design/v3-core-ng-migration.md). It is alpha until it owns every part of a run (see "shared").
#pragma once

#include "dstns/engine.hpp"

namespace dstns::core_ng {

inline constexpr const char* kVersion = "0.7.0";

inline EngineIdentity identity() {
    EngineIdentity out;
    out.version = kVersion;
    out.kind = "real";
    out.channel = "alpha";
    out.owns = {"world selection (urban-crfg-v3, urban-geo-v1)", "scenario compilation", "physics step", "lifecycle table", "world-job table"};
    out.shared = {"checkpoints and seeking", "operator commands", "HTTP API"};
    out.changes = {
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
