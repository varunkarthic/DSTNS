// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/core-ng/lifecycle.hpp"

#include <algorithm>

namespace dstns::core_ng::lifecycle {

const std::vector<std::pair<Lifecycle, Lifecycle>>& table() {
    using enum Lifecycle;
    static const std::vector<std::pair<Lifecycle, Lifecycle>> edges{
        // A reset when nothing is loaded starts the empty state again.
        {Idle, Preparing}, {Idle, Idle}, {Idle, Terminating},
        // A world is installed Ready, then runs or waits. A stop or reset with no world returns to Idle; a failure
        // with a world already there returns to the state that world was in.
        {Preparing, Ready}, {Preparing, Idle}, {Preparing, Stopping}, {Preparing, Stopped}, {Preparing, Completed},
        {Preparing, Terminating},
        {Ready, Running}, {Ready, Paused}, {Ready, Preparing}, {Ready, Seeking}, {Ready, Stopping}, {Ready, Idle},
        {Ready, Terminating},
        // A committed new world replaces a running or paused one (Preparing, then Ready and Paused).
        {Running, Paused}, {Running, Seeking}, {Running, Completed}, {Running, Stopping}, {Running, Preparing},
        {Running, Terminating},
        {Paused, Running}, {Paused, Seeking}, {Paused, Stopping}, {Paused, Preparing}, {Paused, Terminating},
        // A jump lands, or is interrupted by a stop, a reset, a new world or the end of the process.
        {Seeking, Running}, {Seeking, Paused}, {Seeking, Completed}, {Seeking, Stopping}, {Seeking, Preparing},
        {Seeking, Idle}, {Seeking, Terminating},
        {Completed, Seeking}, {Completed, Preparing}, {Completed, Stopping}, {Completed, Idle}, {Completed, Terminating},
        {Stopping, Stopped},
        {Stopped, Preparing}, {Stopped, Seeking}, {Stopped, Idle}, {Stopped, Terminating},
    };
    return edges;
}

bool allowed(Lifecycle from, Lifecycle to) {
    const auto& edges = table();
    return std::find(edges.begin(), edges.end(), std::pair{from, to}) != edges.end();
}

} // namespace dstns::core_ng::lifecycle
