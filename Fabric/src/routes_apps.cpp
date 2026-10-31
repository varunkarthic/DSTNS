// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/fabric/registry.hpp"
#include "operations.hpp"
#include "support.hpp"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <set>

namespace dstns {
using namespace fabric;

namespace {
constexpr const char* kAppId = R"(([a-z0-9.-]+))";

std::string bearer(const httplib::Request& req) {
    const auto header = req.get_header_value("Authorization");
    return header.starts_with("Bearer ") ? header.substr(7) : std::string{};
}

// The observer, or the operator's own tooling, rather than an application. A
// sandboxed frame has an opaque origin and a page elsewhere fails the check; a
// custom header also forces a browser to ask first, which is refused. A local
// process can send this header too, as it can already call /control directly.
bool is_host(const httplib::Request& req) {
    const char* token = std::getenv("DSTNS_OPERATOR_TOKEN");
    if (token && *token && req.get_header_value("X-DSTNS-Operator") == token) return true;
    if (!req.has_header("X-DSTNS-Host")) return false;
    return !req.has_header("Origin") || same_origin(req.get_header_value("Origin"), req.get_header_value("Host"), req.get_header_value("X-Forwarded-Host"));
}

void require_host(const httplib::Request& req) {
    if (!is_host(req)) throw Refusal(403, "HOST_REQUIRED", "only the observer or the operator may do this");
}
} // namespace

// The application-facing half of Fabric: registration, declared UI, events,
// settings and capability-checked control. Everything here is additive.
void ApiServer::routes_apps() {
    const auto route = [](const std::string& tail) { return std::string("/api/v1/fabric/apps/") + kAppId + tail; };
    const auto ok = [](httplib::Response& r, const json& data, int status = 200) { send(r, {{"api_version", kApiVersion}, {"data", data}}, status); };
    // The application's own token.
    const auto owner = [this](const httplib::Request& req) {
        const std::string id = req.matches[1];
        registry_->authenticate(id, bearer(req));
        return id;
    };

    server_->Get("/api/v1/fabric/apps", [this, ok](const auto&, auto& r) { ok(r, {{"items", registry_->list()}}); });
    server_->Post("/api/v1/fabric/apps", [this, ok](const auto& req, auto& r) { ok(r, registry_->register_app(body(req), bearer(req)), 201); });
    server_->Get(route(""), [this, ok](const auto& req, auto& r) { ok(r, registry_->describe(req.matches[1])); });
    server_->Delete(route(""), [this, ok, owner](const auto& req, auto& r) {
        // The application leaves and keeps its identity; a person may forget it.
        if (is_host(req)) registry_->remove(req.matches[1], true);
        else registry_->remove(owner(req), false);
        ok(r, json::object());
    });

    server_->Post(route("/heartbeat"), [this, ok, owner](const auto& req, auto& r) {
        registry_->heartbeat(owner(req));
        ok(r, json::object());
    });
    server_->Put(route("/state"), [this, ok, owner](const auto& req, auto& r) {
        const auto j = body(req);
        registry_->set_state(owner(req), j.at("state").template get<std::string>(), j.value("detail", std::string{}));
        ok(r, json::object());
    });

    server_->Put(route("/ui"), [this, ok, owner](const auto& req, auto& r) {
        registry_->set_ui(owner(req), body(req));
        ok(r, json::object());
    });
    const auto element = route(R"(/ui/([a-z0-9_-]+))");
    server_->Put(element, [this, ok, owner](const auto& req, auto& r) {
        registry_->upsert_element(owner(req), req.matches[2], body(req));
        ok(r, json::object());
    });
    server_->Delete(element, [this, ok, owner](const auto& req, auto& r) {
        registry_->remove_element(owner(req), req.matches[2]);
        ok(r, json::object());
    });

    server_->Post(route("/notifications"), [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "ui.notifications");
        ok(r, {{"sequence", registry_->notify(id, body(req))}}, 202);
    });
    server_->Get(route("/events"), [this, ok, owner](const auto& req, auto& r) {
        ok(r, registry_->events(owner(req), unsigned_parameter(req, "since", 0)));
    });

    // What a person did with something the application put on screen.
    server_->Post(route("/actions"), [this, ok](const auto& req, auto& r) {
        require_host(req);
        const auto j = body(req);
        registry_->post_event(req.matches[1], "ui.action", {{"element", j.at("element")}, {"action", j.value("action", std::string("activate"))}, {"value", j.value("value", json(nullptr))}});
        ok(r, json::object(), 202);
    });

    // Each application's settings are its own: its token, or the person's.
    server_->Get(route("/settings"), [this, ok](const auto& req, auto& r) {
        if (!is_host(req)) registry_->authenticate(req.matches[1], bearer(req));
        ok(r, registry_->settings(req.matches[1]));
    });
    server_->Put(route("/settings"), [this, ok](const auto& req, auto& r) {
        const std::string id = req.matches[1];
        if (!is_host(req)) {
            registry_->authenticate(id, bearer(req));
            registry_->require_capability(id, "settings");
        }
        ok(r, registry_->update_settings(id, body(req)));
    });
    server_->Delete(route("/settings"), [this, ok](const auto& req, auto& r) {
        require_host(req);
        ok(r, registry_->reset_settings(req.matches[1]));
    });

    // Permissions and lifecycle belong to the person watching, not the application.
    server_->Put(route("/grants"), [this, ok](const auto& req, auto& r) {
        require_host(req);
        ok(r, registry_->set_grants(req.matches[1], body(req).at("capabilities")));
    });
    server_->Post(route("/(suspend|resume)"), [this, ok](const auto& req, auto& r) {
        require_host(req);
        registry_->suspend(req.matches[1], req.matches[2] == "suspend");
        ok(r, json::object());
    });
    server_->Post(route("/failure"), [this, ok](const auto& req, auto& r) {
        require_host(req);
        registry_->report_failure(req.matches[1], body(req).value("detail", std::string("The application's frame failed.")));
        ok(r, json::object());
    });

    // Acting on the simulation, with the capability it needs and a record of who
    // did it. Starting runs and terminating the server are not offered: those stay
    // with the operator.
    const bool regeneration_disabled = [] {
        const char* v = std::getenv("DSTNS_DISABLE_WORLD_REGENERATION");
        return v && std::string(v) == "1";
    }();
    server_->Post(route("/control"), [this, owner, regeneration_disabled](const auto& req, auto& r) {
        const auto id = owner(req);
        const auto request = body(req);
        const auto action = request.at("action").template get<std::string>();
        const auto params = request.value("params", json::object());
        const auto capability = control_capability(action);
        if (capability.empty()) throw Refusal(400, "UNKNOWN_ACTION", "unknown control action: " + action);
        registry_->require_capability(id, capability);
        if (action == "regenerate" && regeneration_disabled)
            throw Refusal(403, "WORLD_REGENERATION_DISABLED", "World regeneration is disabled by the operator.");
        const auto record = [&](const std::string& outcome) {
            const auto status = engine_.status();
            registry_->audit(id, action, params, status.value("run_id", std::string{}),
                             status.contains("clock") ? status.at("clock").value("virtual_day_seconds", 0.0) : 0.0, outcome);
            logger_.system("INFO", "fabric", id + " " + action + " " + outcome);
        };
        try {
            const auto result = perform_control(engine_, action, params);
            record("ok");
            send(r, result);
        } catch (const std::exception& e) {
            record(std::string("refused: ") + e.what());
            throw;
        }
    });
    server_->Get("/api/v1/fabric/audit", [this, ok](const auto& req, auto& r) {
        ok(r, {{"items", registry_->audit_log(static_cast<std::size_t>(std::min<std::uint64_t>(2000, unsigned_parameter(req, "limit", 200))))}});
    });

    // The observer's one poll for everything applications have declared.
    server_->Get("/api/v1/fabric/state", [this, ok](const auto& req, auto& r) {
        ok(r, registry_->state(unsigned_parameter(req, "since", 0), unsigned_parameter(req, "notifications_since", 0)));
    });
}
} // namespace dstns
