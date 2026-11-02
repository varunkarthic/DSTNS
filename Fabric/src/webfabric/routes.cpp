// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/webfabric/registry.hpp"
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
        registry_->verify_signature(id, req.method, req.target, req.get_header_value("X-DSTNS-Timestamp"), req.get_header_value("X-DSTNS-Nonce"),
                                    req.get_header_value("X-DSTNS-Signature"), req.body);
        return id;
    };

    server_->Get("/api/v1/fabric/apps", [this, ok](const auto&, auto& r) { ok(r, {{"items", registry_->list()}}); });
    // Features tied to the road network must fit the world that is loaded. A path that
    // is not a real sequence of roads is the application's mistake, so it hears of it now.
    const auto on_network = [this](const json& element) {
        if (!element.is_object() || !element.contains("features")) return;
        const auto problem = engine_.network_problem(element.at("features"));
        if (!problem.empty()) throw Refusal(422, "NOT_ON_NETWORK", problem);
    };
    server_->Post("/api/v1/fabric/apps", [this, ok, on_network](const auto& req, auto& r) {
        const auto manifest = body(req);
        // An application that asked for signed requests means all of them: a stolen token must not be able to
        // turn that off by registering again without it.
        if (manifest.is_object() && manifest.contains("id") && manifest.at("id").is_string() && !bearer(req).empty() && registry_->requires_signature(manifest.at("id").template get<std::string>()))
            registry_->verify_signature(manifest.at("id").template get<std::string>(), req.method, req.target, req.get_header_value("X-DSTNS-Timestamp"), req.get_header_value("X-DSTNS-Nonce"), req.get_header_value("X-DSTNS-Signature"), req.body);
        if (manifest.is_object() && manifest.contains("ui") && manifest.at("ui").is_array())
            for (const auto& element : manifest.at("ui")) on_network(element);
        ok(r, registry_->register_app(manifest, bearer(req)), 201);
    });
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

    server_->Put(route("/ui"), [this, ok, owner, on_network](const auto& req, auto& r) {
        const auto id = owner(req);
        const auto elements = body(req);
        if (elements.is_array())
            for (const auto& element : elements) on_network(element);
        registry_->set_ui(id, elements);
        ok(r, json::object());
    });
    const auto element = route(R"(/ui/([a-z0-9_-]+))");
    server_->Put(element, [this, ok, owner, on_network](const auto& req, auto& r) {
        const auto id = owner(req);
        const auto declared = body(req);
        on_network(declared);
        registry_->upsert_element(id, req.matches[2], declared);
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
        const auto id = owner(req);
        // The simulation reaches an application when it asks: no thread, and no cost for one that wants none of it.
        if (registry_->follows_simulation(id)) {
            const auto status = engine_.status();
            const auto news = engine_.news(registry_->news_cursor(id), 200, 0, false);
            const auto& data = status.contains("data") ? status.at("data") : status;
            registry_->pump(id, status.value("run_id", std::string{}), data.value("lifecycle", std::string{}),
                            status.contains("clock") ? status.at("clock").value("virtual_day_seconds", 0.0) : 0.0,
                            news.contains("data") ? news.at("data").value("items", json::array()) : json::array());
        }
        ok(r, registry_->events(id, unsigned_parameter(req, "since", 0)));
    });

    server_->Post(route("/credentials/rotate"), [this, ok, owner](const auto& req, auto& r) { ok(r, registry_->rotate_credentials(owner(req))); });
    server_->Get("/api/v1/fabric/security", [this, ok](const auto& req, auto& r) {
        require_host(req);
        auto out = registry_->security();
        out["audit"]["verification"] = registry_->audit_verify();
        ok(r, out);
    });
    server_->Get("/api/v1/fabric/audit/verify", [this, ok](const auto& req, auto& r) {
        require_host(req);
        ok(r, registry_->audit_verify());
    });

    // How the launcher should start an application: set by the application itself or the operator,
    // and only ever a proposal. Nothing here runs: a person approves it at the launcher first.
    server_->Put(route("/launch"), [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        ok(r, registry_->propose_launch(id, body(req), "application"));
    });
    server_->Put("/api/v1/fabric/launch/plan", [this, ok](const auto& req, auto& r) {
        require_host(req);
        registry_->set_launch_plan(body(req));
        ok(r, json::object());
    });
    server_->Delete("/api/v1/fabric/launch/plan", [this, ok](const auto& req, auto& r) {
        require_host(req);
        registry_->set_launch_plan(nullptr);
        ok(r, json::object());
    });
    server_->Get("/api/v1/fabric/launch", [this, ok](const auto& req, auto& r) {
        require_host(req);
        ok(r, registry_->launch_proposals());
    });
    server_->Put(R"(/api/v1/fabric/launch/([a-z0-9.-]+))", [this, ok](const auto& req, auto& r) {
        require_host(req);
        ok(r, registry_->propose_launch(req.matches[1], body(req), "operator"));
    });
    server_->Delete(R"(/api/v1/fabric/launch/([a-z0-9.-]+))", [this, ok](const auto& req, auto& r) {
        require_host(req);
        registry_->withdraw_launch(req.matches[1]);
        ok(r, json::object());
    });

    // What the server offers, for an application or a tool to find out rather than assume.
    server_->Get("/api/v1/fabric/capabilities", [ok](const auto&, auto& r) { ok(r, AppRegistry::discovery()); });

    server_->Post(route("/ui/batch"), [this, ok, owner, on_network](const auto& req, auto& r) {
        const auto id = owner(req);
        const auto request = body(req);
        const auto upsert = request.value("upsert", json::array());
        if (upsert.is_array())
            for (const auto& declared : upsert) on_network(declared);
        registry_->batch_ui(id, upsert, request.value("remove", json::array()));
        ok(r, json::object());
    });

    server_->Put(route("/subscriptions"), [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "sim.read");
        ok(r, registry_->subscribe(id, body(req).at("topics")));
    });
    const auto timer = route(R"(/timers/([a-z0-9_-]+))");
    server_->Get(route("/timers"), [this, ok, owner](const auto& req, auto& r) { ok(r, registry_->timers(owner(req))); });
    server_->Put(timer, [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "sim.read");
        ok(r, registry_->set_timer(id, req.matches[2], body(req)));
    });
    server_->Delete(timer, [this, ok, owner](const auto& req, auto& r) {
        registry_->clear_timer(owner(req), req.matches[2]);
        ok(r, json::object());
    });

    const auto stored = route(R"(/storage/([a-z0-9][a-z0-9_-]{0,39}))");
    server_->Get(route("/storage"), [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "storage");
        ok(r, registry_->storage(id));
    });
    server_->Get(stored, [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "storage");
        ok(r, registry_->storage_get(id, req.matches[2]));
    });
    server_->Put(stored, [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "storage");
        registry_->storage_put(id, req.matches[2], body(req));
        ok(r, json::object());
    });
    server_->Delete(stored, [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "storage");
        registry_->storage_delete(id, req.matches[2]);
        ok(r, json::object());
    });

    server_->Post(route("/messages"), [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "apps.messages");
        const auto request = body(req);
        registry_->send_message(id, request.at("to").template get<std::string>(), request);
        ok(r, json::object(), 202);
    });

    // The application's own token, or the person's or a supervisor's.
    server_->Get(route("/health"), [this, ok](const auto& req, auto& r) {
        if (!is_host(req)) registry_->authenticate(req.matches[1], bearer(req));
        ok(r, registry_->health(req.matches[1]));
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

    // Stops of the application's own, with the demand a stop there would see.
    server_->Put(route("/stops"), [this, ok, owner](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "sim.read");
        registry_->set_stops(id, body(req).at("nodes"));
        ok(r, engine_.stop_demand(registry_->stops(id)));
    });
    server_->Get(route("/stops"), [this, ok, owner](const auto& req, auto& r) {
        ok(r, engine_.stop_demand(registry_->stops(owner(req))));
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
    // Recorded, so that what directed the view can be seen afterwards as well as what changed the simulation.
    const auto note = [this](const std::string& id, const std::string& action, const json& params, const std::string& outcome) {
        const auto status = engine_.status();
        registry_->audit(id, action, params, status.value("run_id", std::string{}), status.contains("clock") ? status.at("clock").value("virtual_day_seconds", 0.0) : 0.0, outcome);
    };
    // Directing the view. An application asks, and the observer decides, under its own rules: see docs/api/security.md.
    server_->Post(route("/view"), [this, ok, owner, note](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "ui.camera");
        registry_->spend_direction(id);
        const auto request = body(req);
        try {
            if (request.is_object() && (request.contains("node") || request.contains("edge"))) {
                const auto problem = engine_.network_problem(json::array({request}));
                if (!problem.empty()) throw Refusal(422, "NOT_ON_NETWORK", problem);
            }
            auto asked = registry_->request_view(id, request);
            note(id, "view", request, "asked");
            ok(r, asked, 202);
        } catch (const Refusal& e) {
            note(id, "view", request, std::string("refused: ") + e.code);
            throw;
        }
    });
    server_->Post(route("/view/outcome"), [this, ok](const auto& req, auto& r) {
        require_host(req);
        const auto j = body(req);
        registry_->view_outcome(req.matches[1], j.at("request").template get<std::uint64_t>(), j.at("outcome").template get<std::string>(), j.value("reason", std::string{}));
        ok(r, json::object());
    });
    server_->Put(route("/presentation"), [this, ok, owner, note](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->require_capability(id, "ui.layers");
        registry_->spend_direction(id);
        const auto request = body(req);
        try {
            auto held = registry_->set_presentation(id, request);
            note(id, "presentation", held, "held");
            ok(r, held);
        } catch (const Refusal& e) {
            note(id, "presentation", request, std::string("refused: ") + e.code);
            throw;
        }
    });
    server_->Delete(route("/presentation"), [this, ok, owner, note](const auto& req, auto& r) {
        const auto id = owner(req);
        registry_->clear_presentation(id);
        note(id, "presentation", json::object(), "released");
        ok(r, json::object());
    });
    server_->Post(route("/control"), [this, owner, note, regeneration_disabled](const auto& req, auto& r) {
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
            note(id, action, params, outcome);
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
        ok(r, registry_->state(unsigned_parameter(req, "since", 0), unsigned_parameter(req, "notifications_since", 0), unsigned_parameter(req, "view_since", 0)));
    });
}
} // namespace dstns
