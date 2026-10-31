// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "operations.hpp"
#include "support.hpp"

namespace dstns {
using namespace fabric;

// Moving through simulated time.
void ApiServer::routes_playback() {
    // Playback API
    server_->Get("/api/v1/playback/status", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Post("/api/v1/playback/start", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        const auto start = j.contains("start_virtual_time") ? time_value(j.at("start_virtual_time")) : 0;
        auto res = engine_.start_async(seed, c, start);
        send(r, res, 202);
    });
    server_->Post("/api/v1/playback/pause", [this](const auto& req, auto& r) { send(r, engine_.pause(body(req))); });
    server_->Post("/api/v1/playback/play", [this](const auto& req, auto& r) { send(r, engine_.play(body(req))); });
    server_->Post("/api/v1/playback/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/api/v1/playback/reset", [this](const auto&, auto& r) { send(r, engine_.reset()); });
    server_->Post("/api/v1/playback/seek", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.seek(time_value(j.at("target_time")), j.value("play", false)));
    });

    // Advance a fixed amount of virtual time and hold there.
    server_->Post("/api/v1/playback/step", [this](const auto& req, auto& r) {
        send(r, step(engine_, body(req)));
    });

    server_->Post("/api/v1/playback/prepare", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        send(r, engine_.prepare(seed, c), 200);
    });
}
} // namespace dstns
