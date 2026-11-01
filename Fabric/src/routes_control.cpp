// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "operations.hpp"
#include "support.hpp"

#include <tuple>

namespace dstns {
using namespace fabric;

// Acting on the running simulation.
void ApiServer::routes_control() {
    // As with playback: under Fabric, with the older paths still answering and saying so. A path
    // is written once, with {name} where the part that varies goes.
    const std::string engine = kEngineBase;
    const auto paths = [engine](const std::string& tail) {
        std::string pattern = tail, shown = tail;
        const auto swap = [](std::string& text, const std::string& from, const std::string& to) {
            const auto at = text.find(from);
            if (at != std::string::npos) text.replace(at, from.size(), to);
        };
        swap(pattern, "{module}", "([a-z-]+)");
        swap(pattern, "{id}", R"((\d+))");
        swap(pattern, "{switch}", "(enable|disable)");
        swap(shown, "{switch}", "enable");
        return std::tuple{pattern, engine + shown};
    };
    const auto post = [this, engine, paths](const std::string& tail, httplib::Server::Handler handler) {
        const auto [pattern, shown] = paths(tail);
        server_->Post("/api/v1/control" + pattern, legacy_route(shown, handler));
        server_->Post(engine + pattern, handler);
    };
    const auto put = [this, engine, paths](const std::string& tail, httplib::Server::Handler handler) {
        const auto [pattern, shown] = paths(tail);
        server_->Put("/api/v1/control" + pattern, legacy_route(shown, handler));
        server_->Put(engine + pattern, handler);
    };
    put("/tick-rate", [this](const auto& req, auto& r) { send(r, engine_.set_tick_rate(body(req).at("tick_rate"))); });
    post("/day", [this](const auto& req, auto& r) { send(r, engine_.set_day(body(req).at("day"))); });
    put("/modules/{module}", [this](const auto& req, auto& r) { send(r, engine_.set_module(req.matches[1], body(req).at("enabled"))); });
    post("/modules/{module}/{switch}", [this](const auto& req, auto& r) { send(r, engine_.set_module(req.matches[1], req.matches[2] == "enable")); });
    post("/events/weather", [this](const auto& req, auto& r) { send(r, add_weather(engine_, body(req)), 202); });
    post("/events/traffic", [this](const httplib::Request& req, httplib::Response& r) { send(r, add_traffic(engine_, body(req)), 202); });
    const httplib::Server::Handler edge_override = [this](const auto& req, auto& r) {
        const auto j = body(req);
        const auto edge_id = path_id(req.matches[1]);
        send(r, override_edge(engine_, edge_id, j));
    };
    put("/edges/{id}", edge_override);
    post("/edges/{id}/override", edge_override);
    const httplib::Server::Handler toggle = [this](const auto& req, auto& r) {
        const auto node_id = path_id(req.matches[1]);
        send(r, engine_.toggle_signal(NodeId{node_id}));
    };
    post("/signals/{id}/toggle", toggle);
    post("/signals/{id}", toggle);
    post("/events/surge", [this](const auto& req, auto& r) { send(r, add_surge(engine_, body(req)), 202); });
    server_->Post("/api/v1/control/transit/route", [](const auto&, auto& r) {
        r.set_header("Deprecation","true");
        send(r,{{"error",{{"code","TRANSIT_API_RETIRED"},{"message","Transit route dispatch is no longer supported."}}}},410);
    });

    post("/undo", [this](const auto& req, auto& r) { send(r, engine_.undo(history_count(body(req)))); });
    post("/redo", [this](const auto& req, auto& r) { send(r, engine_.redo(history_count(body(req)))); });
    const httplib::Server::Handler history = [this](const auto&, auto& r) { send(r, engine_.history()); };
    server_->Get("/api/v1/control/history", legacy_route(engine + "/history", history));
    server_->Get(engine + "/history", history);
}
} // namespace dstns
