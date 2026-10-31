// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "support.hpp"

#include <cstdlib>

namespace dstns {
using namespace fabric;

// Replacing the world with a new one.
void ApiServer::routes_world() {
    // World regeneration. The observer may ask for a new world, but may not
    // choose anything about it: the seed comes from the secure generator and
    // every other parameter is copied from the run the operator started. That
    // keeps scenario configuration with the CLI. Operators can disable this
    // entirely with DSTNS_DISABLE_WORLD_REGENERATION=1.
    const bool regeneration_disabled = [] {
        const char* v = std::getenv("DSTNS_DISABLE_WORLD_REGENERATION");
        return v && std::string(v) == "1";
    }();
    server_->Post("/api/v1/world/regenerate", [this, regeneration_disabled](const auto& req, auto& r) {
        if (regeneration_disabled) {
            send(r, {{"api_version", kApiVersion},
                     {"error", {{"code", "WORLD_REGENERATION_DISABLED"},
                                {"message", "World regeneration is disabled by the operator."}}}}, 403);
            return;
        }
        send(r, engine_.regenerate_world(body(req)), 202);
    });
    server_->Get("/api/v1/world/status", [this, regeneration_disabled](const auto&, auto& r) {
        auto status = engine_.world_status();
        status["data"]["enabled"] = !regeneration_disabled;
        send(r, status);
    });
}
} // namespace dstns
