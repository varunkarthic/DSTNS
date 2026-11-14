// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The engines DSTNS ships, installed into a runtime host: core-ng (the default) and core-legacy, each through the
// same hooks, with core-ng's lifecycle and world-job tables checking every transition. The server and every test or
// tool that runs worlds call this; the host itself knows no engine.
#pragma once

#include "dstns/engine.hpp"

namespace dstns {
void install_engines(SimulationEngine& engine);
}
