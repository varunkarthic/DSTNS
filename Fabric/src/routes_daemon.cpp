// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The daemons, through Fabric: what is running (asked by anyone), their two queues (for applications, the observer and
// the operator), and turning them on and off (the operator).

#include "dstns/api.hpp"
#include "dstns/daemon.hpp"
#include "dstns/webfabric/registry.hpp"
#include "dstns/osm_fetch.hpp"
#include "support.hpp"

#include <httplib.h>

#include <cstdlib>
#include <fstream>

namespace dstns {

using namespace fabric;

namespace {

json alerts_file() {
    // The operator's own copy, if there is one; otherwise those built in, which are the same file as shipped.
    for (const char* where : {"config/daemon-alerts.json"}) {
        try {
            std::ifstream in(where);
            if (in) return json::parse(in);
        } catch (const std::exception&) {
        }
    }
    return daemon::default_alerts();
}

json settings_from_environment() {
    const char* text = std::getenv("DSTNS_DAEMON");
    if (!text || !*text) return json::object();
    try {
        return json::parse(text);
    } catch (const std::exception&) {
        return json::object();
    }
}

std::string bearer_of(const httplib::Request& req) {
    const auto header = req.get_header_value("Authorization");
    return header.starts_with("Bearer ") ? header.substr(7) : std::string{};
}

} // namespace

std::unique_ptr<daemon::Handler> make_daemons(SimulationEngine& engine, RuntimeLogger& logger) {
    const char* maps = std::getenv("DSTNS_MAPS_DIR");
    daemon::Host host{
        .lifecycle = [&engine] { return std::string(to_string(engine.lifecycle())); },
        .virtual_seconds = [&engine] { return engine.try_virtual_seconds(); },
        .download_groups = [] { return map_download_pids(); },
        .keep = [&engine] {
            std::vector<std::filesystem::path> keep;
            if (const auto file = engine.try_map_file(); file && !file->empty() && *file != "auto") keep.emplace_back(*file);
            return keep;
        },
        .map_cache = maps && *maps ? std::filesystem::path(maps) : std::filesystem::path("data/maps"),
        .logs = logger.log_directory(),
        .log = [&logger](const std::string& level, const std::string& text) { logger.system(level, "daemon", text); },
    };
    return std::make_unique<daemon::Handler>(std::move(host), settings_from_environment(), alerts_file());
}

void ApiServer::routes_daemon() {
    const auto ok = [](httplib::Response& r, const json& data, int status = 200) { send(r, {{"api_version", kApiVersion}, {"data", data}}, status); };
    // Who is reading: the observer or the operator, or an application by its own token. Anyone else is turned away.
    const auto reader = [this](const httplib::Request& req) -> std::string {
        if (is_operator(req)) return "operator";
        if (is_host(req)) return "observer";
        const auto app = req.has_param("app") ? req.get_param_value("app") : req.get_header_value("X-DSTNS-App");
        if (app.empty()) throw Refusal(401, "APP_REQUIRED", "say which application is reading, with ?app=ID and its token");
        registry_->authenticate(app, bearer_of(req));
        return app;
    };
    const auto require_operator = [](const httplib::Request& req) {
        if (!is_operator(req)) throw Refusal(403, "OPERATOR_REQUIRED", "only the operator may change the daemons");
    };
    const auto live = [this]() -> daemon::Handler& {
        if (!daemons_ || !daemons_->enabled()) throw Refusal(409, "DAEMONS_OFF", "the daemons are turned off");
        return *daemons_;
    };

    // What anyone may know, without asking first.
    server_->Get("/api/v1/daemon", [this, ok](const httplib::Request&, httplib::Response& r) { ok(r, daemons_ ? daemons_->overview() : json{{"enabled", false}}); });
    server_->Get("/api/v1/daemon/messages", [this, ok](const httplib::Request&, httplib::Response& r) { ok(r, daemons_ ? daemons_->gateway().templates() : json::object()); });

    // The two queues. ?since= is the last sequence seen; ?wait= waits up to 25 s for something new.
    const auto queue = [ok, reader, live](bool emergency) {
        return [ok, reader, live, emergency](const httplib::Request& req, httplib::Response& r) {
            const auto who = reader(req);
            auto& handler = live();
            const auto since = unsigned_parameter(req, "since", 0);
            const auto limit = page_parameter(req, "limit", 100, 500);
            const double wait = std::min(25.0, std::max(0.0, req.has_param("wait") ? std::atof(req.get_param_value("wait").c_str()) : 0.0));
            auto& q = emergency ? handler.gateway().emergency() : handler.gateway().notification();
            ok(r, q.read(since, limit, wait, who));
        };
    };
    server_->Get("/api/v1/daemon/emergency-queue", queue(true));
    server_->Get("/api/v1/daemon/notification-queue", queue(false));
    // An emergency heard and acted on.
    server_->Post(R"(/api/v1/daemon/emergency-queue/(\d+)/ack)", [ok, reader, live](const httplib::Request& req, httplib::Response& r) {
        const auto who = reader(req);
        const auto sequence = std::stoull(req.matches[1].str());
        if (!live().gateway().emergency().acknowledge(sequence, who)) throw Refusal(404, "NOT_FOUND", "no such emergency, or it has left the queue");
        ok(r, {{"sequence", sequence}, {"acknowledged_by", who}});
    });

    // The processes a module runs in, from the launcher: itself, and the applications it started.
    server_->Put("/api/v1/daemon/rcs/processes", [ok, require_operator, live](const httplib::Request& req, httplib::Response& r) {
        require_operator(req);
        const auto j = body(req);
        const auto module = j.value("module", "");
        if (module.empty() || module == "engine" || module == "downloads") throw Refusal(400, "BAD_MODULE", "module is launcher, applications, or one of your own");
        std::vector<int> pids;
        for (const auto& pid : j.value("pids", json::array()))
            if (pid.is_number_integer() && pid.get<int>() > 1) pids.push_back(pid.get<int>());
        live().set_processes(module, pids);
        ok(r, {{"module", module}, {"pids", pids}});
    });

    // One daemon: its readings and settings; and, for the operator, on or off and its settings.
    server_->Get(R"(/api/v1/daemon/([a-z]+))", [ok, reader, live](const httplib::Request& req, httplib::Response& r) {
        reader(req);
        const auto detail = live().detail(req.matches[1].str());
        if (!detail) throw Refusal(404, "NOT_FOUND", "no daemon " + req.matches[1].str());
        ok(r, *detail);
    });
    server_->Put(R"(/api/v1/daemon/([a-z]+))", [ok, require_operator, live](const httplib::Request& req, httplib::Response& r) {
        require_operator(req);
        auto& handler = live();
        const std::string name = req.matches[1];
        if (!handler.find(name)) throw Refusal(404, "NOT_FOUND", "no daemon " + name);
        const auto j = body(req);
        if (j.contains("enabled")) handler.set_enabled(name, j.at("enabled").get<bool>());
        if (j.contains("settings")) {
            if (!j.at("settings").is_object()) throw Refusal(400, "BAD_SETTINGS", "settings is an object");
            handler.update_settings({{name, j.at("settings")}});
        }
        if (j.contains("sustain_s")) handler.update_settings({{"sustain_s", std::max(0.0, j.at("sustain_s").get<double>())}});
        ok(r, *handler.detail(name));
    });
}

} // namespace dstns
