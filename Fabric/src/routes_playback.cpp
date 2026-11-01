// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "operations.hpp"
#include "support.hpp"

namespace dstns {
using namespace fabric;

// Moving through simulated time.
void ApiServer::routes_playback() {
    // The engine's controls belong to Fabric, and are authorized there (see install_guards). The
    // older paths keep working, and say what replaced them.
    const std::string engine = kEngineBase;
    const auto get = [this, engine](const std::string& name, httplib::Server::Handler handler) {
        server_->Get("/api/v1/playback/" + name, legacy_route(engine + "/" + name, handler));
        server_->Get(engine + "/" + name, handler);
    };
    const auto post = [this, engine](const std::string& name, httplib::Server::Handler handler) {
        server_->Post("/api/v1/playback/" + name, legacy_route(engine + "/" + name, handler));
        server_->Post(engine + "/" + name, handler);
    };
    get("status", [this](const auto&, auto& r) { send(r, engine_.status()); });
    post("start", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        const auto start = j.contains("start_virtual_time") ? time_value(j.at("start_virtual_time")) : 0;
        auto res = engine_.start_async(seed, c, start);
        send(r, res, 202);
    });
    post("pause", [this](const auto& req, auto& r) { send(r, engine_.pause(body(req))); });
    post("play", [this](const auto& req, auto& r) { send(r, engine_.play(body(req))); });
    post("stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/stop", legacy_route(engine + "/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); }));
    post("reset", [this](const auto&, auto& r) { send(r, engine_.reset()); });
    post("seek", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.seek(time_value(j.at("target_time")), j.value("play", false)));
    });

    // Advance a fixed amount of virtual time and hold there.
    post("step", [this](const auto& req, auto& r) { send(r, step(engine_, body(req))); });

    post("prepare", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        send(r, engine_.prepare(seed, c), 200);
    });
}
} // namespace dstns
