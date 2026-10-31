// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "support.hpp"

#include <cmath>

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
        auto j = body(req);
        const double default_rad = 350.0;
        const double minutes = j.value("duration_virtual_minutes", 60.0);
        // Checked as a double: converting a negative or enormous value to an
        // unsigned integer first would be undefined.
        if (!std::isfinite(minutes) || minutes < 1 || minutes > 1440)
            throw std::invalid_argument("duration_virtual_minutes must be in [1, 1440]");
        send(r, engine_.add_weather(
            NodeId{j.at("epicenter_node")},
            j.value("intensity", 0.85),
            j.value("radius_m", default_rad),
            static_cast<std::uint32_t>(minutes),
            j.value("flood_gain", 0.5)
        ), 202);
    });
    server_->Post("/api/v1/control/events/traffic", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto target = j.at("target");
        if (target.at("type") != "edge") throw std::invalid_argument("V1 traffic overlays require an edge target");
        const auto pressure = j.at("congestion_pressure").get<double>();
        if (!std::isfinite(pressure) || pressure < 0 || pressure > 1) {
            throw std::invalid_argument("congestion_pressure must be in [0,1]");
        }
        send(r, engine_.override_edge(EdgeId{target.at("id").get<std::uint32_t>()}, 1.0, 1.0 - .75 * pressure, false), 202);
    });
    auto edge_override_handler = [this](const auto& req, auto& r) {
        auto j = body(req);
        const auto edge_id = path_id(req.matches[1]);
        send(r, engine_.override_edge(
            EdgeId{edge_id},
            j.value("speed_multiplier", 1.0),
            j.value("capacity_multiplier", 1.0),
            j.value("closed", false)
        ));
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
        auto j = body(req);
        send(r, engine_.trigger_surge(
            NodeId{j.at("node_id")},
            j.value("factor", 1.8),
            j.value("radius_m", 350.0),
            j.value("duration_s", 1800u)
        ), 202);
    });
    server_->Post("/api/v1/control/transit/route", [](const auto&, auto& r) {
        r.set_header("Deprecation","true");
        send(r,{{"error",{{"code","TRANSIT_API_RETIRED"},{"message","Transit route dispatch is no longer supported."}}}},410);
    });

    // Read as a signed integer: nlohmann converts -1 to an unsigned type by
    // wrapping it, which would undo the whole history.
    auto history_count = [](const json& j) {
        const auto count = j.value("count", std::int64_t{1});
        if (count < 1 || count > 10000) throw std::invalid_argument("count must be in [1, 10000]");
        return static_cast<std::uint32_t>(count);
    };
    server_->Post("/api/v1/control/undo", [this, history_count](const auto& req, auto& r) {
        send(r, engine_.undo(history_count(body(req))));
    });
    server_->Post("/api/v1/control/redo", [this, history_count](const auto& req, auto& r) {
        send(r, engine_.redo(history_count(body(req))));
    });
    server_->Get("/api/v1/control/history", [this](const auto&, auto& r) {
        send(r, engine_.history());
    });
}
} // namespace dstns
