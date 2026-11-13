// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// core-ng's world-generation job: the states GET /api/v1/world/status reports, and every allowed change between them,
// as data. The engine reports each change to allowed(); one outside the table is logged as an error.
//
//   idle        no job, or a staged world was discarded
//   generating  a new world is being prepared, or installed
//   staged      prepared, and waiting for a person to confirm it
//   ready       installed
//   failed      the map could not be fetched, the compile failed, or a stop, reset or termination cancelled it

#include <string>
#include <utility>
#include <vector>

namespace dstns::core_ng::world {

[[nodiscard]] const std::vector<std::pair<std::string, std::string>>& table();
[[nodiscard]] bool allowed(const std::string& from, const std::string& to);

} // namespace dstns::core_ng::world
