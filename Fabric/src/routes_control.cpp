// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "operations.hpp"
#include "support.hpp"

namespace dstns {
using namespace fabric;

// Acting on the running simulation.
void ApiServer::routes_control() {
    // Control API
    server_->Put("/api/v1/control/tick-rate", [this](const auto& req, auto& r) {
        send(r, engine_.set_tick_rate(body(req).at("tick_rate")));
    });
    server_->Post("/api/v1/control/day", [this](const auto& req, auto& r) {
        send(r, engine_.set_day(body(req).at("day")));
    });
    server_->Put(R"(/api/v1/control/modules/([a-z-]+))", [this](const auto& req, auto& r) {
        send(r, engine_.set_module(req.matches[1], body(req).at("enabled")));
    });
    server_->Post(R"(/api/v1/control/modules/([a-z-]+)/(enable|disable))", [this](const auto& req, auto& r) {
        send(r, engine_.set_module(req.matches[1], req.matches[2] == "enable"));
    });
    server_->Post("/api/v1/control/events/weather", [this](const auto& req, auto& r) {
        send(r, add_weather(engine_, body(req)), 202);
    });
    server_->Post("/api/v1/control/events/traffic", [this](const httplib::Request& req, httplib::Response& r) {
        send(r, add_traffic(engine_, body(req)), 202);
    });
    auto edge_override_handler = [this](const auto& req, auto& r) {
        const auto j = body(req);
        const auto edge_id = path_id(req.matches[1]);
        send(r, override_edge(engine_, edge_id, j));
    };
    server_->Put(R"(/api/v1/control/edges/(\d+))", edge_override_handler);
    server_->Post(R"(/api/v1/control/edges/(\d+)/override)", edge_override_handler);

    server_->Post(R"(/api/v1/control/signals/(\d+)/toggle)", [this](const auto& req, auto& r) {
        const auto node_id = path_id(req.matches[1]);
        send(r, engine_.toggle_signal(NodeId{node_id}));
    });
    server_->Post(R"(/api/v1/control/signals/(\d+))", [this](const auto& req, auto& r) {
        const auto node_id = path_id(req.matches[1]);
        send(r, engine_.toggle_signal(NodeId{node_id}));
    });
    server_->Post("/api/v1/control/events/surge", [this](const auto& req, auto& r) {
        send(r, add_surge(engine_, body(req)), 202);
    });
    server_->Post("/api/v1/control/transit/route", [](const auto&, auto& r) {
        r.set_header("Deprecation","true");
        send(r,{{"error",{{"code","TRANSIT_API_RETIRED"},{"message","Transit route dispatch is no longer supported."}}}},410);
    });

    server_->Post("/api/v1/control/undo", [this](const auto& req, auto& r) {
        send(r, engine_.undo(history_count(body(req))));
    });
    server_->Post("/api/v1/control/redo", [this](const auto& req, auto& r) {
        send(r, engine_.redo(history_count(body(req))));
    });
    server_->Get("/api/v1/control/history", [this](const auto&, auto& r) {
        send(r, engine_.history());
    });
}
} // namespace dstns
