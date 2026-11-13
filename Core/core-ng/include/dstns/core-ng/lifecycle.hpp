// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// core-ng's engine lifecycle: every allowed transition as data, in one table. The engine reports each transition it
// makes to allowed(); one that is not in the table is logged as an error, and the tests require there are none.
// docs/design/state-machines.md shows the same table.

#include "dstns/engine.hpp"

#include <utility>
#include <vector>

namespace dstns::core_ng::lifecycle {

// Every allowed (from, to) pair. Booting and Error are named for the API contract and never entered.
[[nodiscard]] const std::vector<std::pair<Lifecycle, Lifecycle>>& table();
[[nodiscard]] bool allowed(Lifecycle from, Lifecycle to);

} // namespace dstns::core_ng::lifecycle
