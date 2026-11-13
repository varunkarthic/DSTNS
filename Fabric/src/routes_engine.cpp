// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/webfabric/registry.hpp"
#include "gate.hpp"
#include "support.hpp"

#include <algorithm>

namespace dstns {
using namespace fabric;

// The engines: what is installed and what is running, and the acknowledgment an unstable engine's run waits for.
void ApiServer::routes_engine() {
    server_->Get("/api/v1/engine", [this](const auto&, auto& r) {
        const auto status = engine_.status();
        send(r, {{"ok", true}, {"api_version", kApiVersion}, {"data", {
            // The engine of the world that is running, from the world itself, not from what was asked for.
            {"running", status.contains("data") ? status["data"].value("engine_identity", json(nullptr)) : json(nullptr)},
            {"catalogue", engine_.catalogue()},
            {"config", gate_->config().to_json()},
            {"approval", gate_->state(engine_.catalogue())},
        }}});
    });
    server_->Get("/api/v1/engine/approval", [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"api_version", kApiVersion}, {"data", gate_->state(engine_.catalogue())}});
    });
    // A long poll: returns as soon as the approval moves past `since`, or after `timeout` seconds (at most 30).
    server_->Get("/api/v1/engine/approval/wait", [this](const httplib::Request& req, auto& r) {
        const auto since = req.has_param("since") ? std::stoull(req.get_param_value("since")) : 0ULL;
        const auto seconds = std::clamp(req.has_param("timeout") ? std::stoi(req.get_param_value("timeout")) : 25, 0, 30);
        send(r, {{"ok", true}, {"api_version", kApiVersion}, {"data", gate_->wait(since, std::chrono::seconds(seconds), engine_.catalogue())}});
    });
    server_->Post("/api/v1/engine/approval", [this](const httplib::Request& req, auto& r) {
        if (!is_host(req)) throw Refusal(401, "AUTHORIZATION_REQUIRED", "Only the observer or the operator may decide a start.");
        const auto j = body(req);
        const auto now = gate_->state(engine_.catalogue());
        // An acknowledgment set to the launcher is the operator's alone.
        if (now.contains("approval") && now["approval"].value("acknowledge_in", std::string()) == "launcher" && !is_operator(req))
            throw Refusal(403, "ACKNOWLEDGE_IN_LAUNCHER", "This engine's runs are acknowledged in the launcher.");
        auto decision = gate_->decide(j.value("approval_id", std::string()), j.value("decision", std::string()), j.value("then", std::string()),
                                      j.value("engine", std::string()), engine_.catalogue());
        json answer = decision.answer;
        if (decision.run) {
            // Accepted, or rejected with a new start on a stable engine: the held start runs once, here.
            try {
                const auto& run = *decision.run;
                auto config = config_from(run);
                engine_.check_engine(config);
                const auto start = run.contains("start_virtual_time") ? time_value(run.at("start_virtual_time")) : 0;
                answer["started"] = engine_.start_async(seed_from(run), config, start);
            } catch (const std::exception& e) {
                answer["start_error"] = e.what();
            }
        } else if (j.value("then", std::string()) == "terminate") {
            answer["terminating"] = true;
            send(r, {{"ok", true}, {"api_version", kApiVersion}, {"data", answer}});
            terminate_now();
            return;
        }
        send(r, {{"ok", true}, {"api_version", kApiVersion}, {"data", answer}});
    });
}
} // namespace dstns
