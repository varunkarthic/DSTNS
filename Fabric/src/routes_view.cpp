// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "support.hpp"

#include <limits>
#include <regex>

namespace dstns {
using namespace fabric;

// Reading the world and its live state.
void ApiServer::routes_view() {
    // View API
    server_->Get("/api/v1/view/run", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Get("/api/v1/view/config", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Get("/api/v1/view/manifest", [this](const auto&, auto& r) { send(r, engine_.manifest()); });
    // Served from the per-world cache; see SimulationEngine::topology_text.
    auto topology_handler = [this](const auto&, auto& r) { r.set_content(engine_.topology_text(), "application/json"); };
    server_->Get("/api/v1/view/topology", topology_handler);
    server_->Get("/api/v1/topology", topology_handler);
    server_->Get("/api/v1/view/network", topology_handler);
    server_->Get("/api/v1/view/map/full", topology_handler);
    server_->Get("/api/v1/view/snapshot", [this](const auto&, auto& r) {
        // Snapshots are the bulk of what the observer consumes, so their size
        // and cadence are what ASB reports as the delivered data rate.
        send(r, engine_.snapshot());
        engine_.note_delivery(r.body.size());
    });
    server_->Get("/api/v1/view/global", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/world", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/all", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/global.json", [this](const auto&, auto& r) { send(r, engine_.global_view()); });

    server_->Get("/api/v1/view/nodes", [this](const auto& req, auto& r) {
        send(r, engine_.nodes(
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",250,1000)
        ));
    });
    server_->Get("/api/v1/view/edges", [this](const auto& req, auto& r) {
        send(r, engine_.edges(
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",250,1000)
        ));
    });
    server_->Get(R"(/api/v1/view/nodes/(\d+))", [this](const auto& req, auto& r) {
        const auto id = path_id(req.matches[1]);
        auto result = engine_.nodes(id, 1);
        if (result["data"]["items"].empty()) throw std::out_of_range("unknown node");
        send(r, result);
    });
    server_->Get(R"(/api/v1/view/edges/(\d+))", [this](const auto& req, auto& r) {
        const auto id = path_id(req.matches[1]);
        auto result = engine_.edges(id, 1);
        if (result["data"]["items"].empty()) throw std::out_of_range("unknown edge");
        send(r, result);
    });

    // Places. The classified view of the world's features: what each one is,
    // what the demand model believes about it, and why.
    auto places_handler = [this](const httplib::Request& req, httplib::Response& r) {
        const auto kind = req.has_param("kind") ? req.get_param_value("kind") : std::string{};
        if (!kind.empty() && !std::regex_match(kind, std::regex("[a-z_]{1,32}")))
            throw std::invalid_argument("invalid place kind");
        send(r, engine_.places(
            kind,
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",500,2000)
        ));
    };
    server_->Get("/api/v1/view/places", places_handler);
    server_->Get("/api/v1/places", places_handler);
    server_->Get("/api/v1/view/place-kinds", [this](const auto&, auto& r) { send(r, engine_.place_kinds()); });
    // Stops are places too; this is the same data narrowed to one kind, so a
    // transit client need not know the taxonomy to ask the obvious question.
    server_->Get("/api/v1/view/stops", [this](const httplib::Request& req, httplib::Response& r) {
        send(r, engine_.places("bus_stop",
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",500,2000)));
    });

    for (const auto* kind : {"traffic", "weather", "buildings", "bus-stops", "signals", "events", "metrics", "incidents", "congestion"}) {
        const auto path = std::string("/api/v1/view/") + kind;
        server_->Get(path, [this, kind](const auto&, auto& r) { send(r, engine_.catalog(kind)); });
    }

    server_->Get("/api/v1/view/event-queue",[this](const auto& req,auto& r){
        auto number=[&](const char* key,std::size_t fallback,std::size_t max){if(!req.has_param(key))return fallback;auto value=req.get_param_value(key);if(!std::regex_match(value,std::regex("[0-9]{1,6}")))throw std::invalid_argument("invalid event pagination");auto n=std::stoul(value);if(n>max)throw std::invalid_argument("event pagination out of range");return n;};
        const auto view=req.has_param("view")?req.get_param_value("view"):"future";
        const auto category=req.has_param("category")?req.get_param_value("category"):"all";
        if(view!="future"&&view!="history")throw std::invalid_argument("view must be future or history");
        if(category!="all"&&category!="signals"&&category!="demand"&&category!="incidents"&&category!="weather"&&category!="flooding"&&category!="system")throw std::invalid_argument("invalid event category");
        const auto limit=number("limit",50,200);if(!limit)throw std::invalid_argument("limit must be positive");
        send(r,engine_.scheduled_events(view=="future",category,number("offset",0,100000),limit));
    });
}
} // namespace dstns
