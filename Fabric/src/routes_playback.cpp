// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "operations.hpp"
#include "support.hpp"
#include "gate.hpp"

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
    // A start on an unstable engine whose acknowledgment is enforced is held by the gate, and answered as deferred:
    // nothing runs until a person accepts it (POST /api/v1/engine/approval). Any other start replaces one waiting.
    const auto held = [this](const httplib::Request& req, httplib::Response& r, const json& j, const ScenarioConfig& c) {
        gate_->require_enabled(c.engine);
        engine_.check_engine(c);
        const auto identity = engine_.identity(c.engine);
        if (gate_->gated(identity)) {
            send(r, {{"ok", true}, {"api_version", kApiVersion}, {"data", gate_->hold(j, identity, req.get_header_value("Idempotency-Key"))}}, 202);
            return true;
        }
        gate_->cancel("another start replaced it");
        gate_->run_ended();
        return false;
    };
    post("start", [this, held](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        if (held(req, r, j, c)) return;
        const auto start = j.contains("start_virtual_time") ? time_value(j.at("start_virtual_time")) : 0;
        auto res = engine_.start_async(seed, c, start);
        send(r, res, 202);
    });
    post("pause", [this](const auto& req, auto& r) { send(r, engine_.pause(body(req))); });
    post("play", [this](const auto& req, auto& r) { send(r, engine_.play(body(req))); });
    // Stopping or resetting ends the run: a start still waiting is cancelled, and the next one is acknowledged afresh.
    post("stop", [this](const auto&, auto& r) { gate_->cancel("the operator stopped it"); gate_->run_ended(); send(r, engine_.stop()); });
    server_->Post("/stop", legacy_route(engine + "/stop", [this](const auto&, auto& r) { gate_->cancel("the operator stopped it"); gate_->run_ended(); send(r, engine_.stop()); }));
    post("reset", [this](const auto&, auto& r) { gate_->cancel("the operator reset it"); gate_->run_ended(); send(r, engine_.reset()); });
    post("seek", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.seek(time_value(j.at("target_time")), j.value("play", false)));
    });

    // Advance a fixed amount of virtual time and hold there.
    post("step", [this](const auto& req, auto& r) { send(r, step(engine_, body(req))); });

    post("prepare", [this, held](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        if (held(req, r, j, c)) return;
        send(r, engine_.prepare(seed, c), 200);
    });
}
} // namespace dstns
