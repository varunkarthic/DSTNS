// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/core-ng/world.hpp"

#include <algorithm>

namespace dstns::core_ng::world {

const std::vector<std::pair<std::string, std::string>>& table() {
    static const std::vector<std::pair<std::string, std::string>> edges{
        // A new job, from any settled state; a staged world is replaced by a new one, or committed.
        {"idle", "generating"}, {"ready", "generating"}, {"failed", "generating"}, {"staged", "generating"},
        {"generating", "staged"}, {"generating", "ready"}, {"generating", "failed"},
        // Discarded: a staged world, or one still being prepared to be staged.
        {"staged", "idle"}, {"generating", "idle"},
        // A stop, reset or termination cancels a staged world.
        {"staged", "failed"},
    };
    return edges;
}

bool allowed(const std::string& from, const std::string& to) {
    const auto& edges = table();
    return std::find(edges.begin(), edges.end(), std::pair{from, to}) != edges.end();
}

} // namespace dstns::core_ng::world
