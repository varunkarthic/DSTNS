// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Applications registering themselves with Fabric, against a real server.
//
// Several applications at once: identity and conflicts, capability enforcement, settings isolation, validation,
// migration, persistence across a restart, failure isolation, lease expiry and lossless event delivery.
#include "harness.hpp"

#include <sys/stat.h>

#include <filesystem>
#include <fstream>
#include <future>
#include <set>

using namespace check;

namespace {

const std::string BASE = "/api/v1/fabric/apps";
const Headers HOST = {{"X-DSTNS-Host", "observer"}};

json manifest(const std::string& id, json extra = json::object()) {
    std::string name = id.substr(id.rfind('.') + 1);
    name[0] = static_cast<char>(std::toupper(name[0]));
    json out = {{"id", id}, {"name", name}, {"version", "1.0.0"}, {"capabilities", {"ui.status", "ui.notifications", "settings", "sim.read"}},
                {"settings", {{"version", 1}, {"groups", {{{"id", "general"}, {"label", "General"}, {"fields", {
                    {{"id", "enabled"}, {"label", "Enabled"}, {"type", "toggle"}, {"default", true}},
                    {{"id", "level"}, {"label", "Level"}, {"type", "slider"}, {"min", 0}, {"max", 10}, {"default", 5}},
                    {{"id", "mode"}, {"label", "Mode"}, {"type", "select"}, {"default", "a"}, {"options", {{{"value", "a"}, {"label", "A"}}, {{"value", "b"}, {"label", "B"}}}}},
                    {{"id", "name"}, {"label", "Name"}, {"type", "text"}, {"default", "x"}, {"max_length", 8}}}}}}}}}};
    out.update(extra);
    return out;
}

void until_running(const Server& server, double seconds) {
    until([&] { return server.call("GET", "/api/v1/playback/status").data().at("lifecycle") == "RUNNING"; }, seconds, "the run");
}

} // namespace

int main() {
    TempDir tmp("dstns-fabric-");
    std::vector<std::string> ids;
    for (int i = 0; i < 12; ++i) ids.push_back("org.example.app" + std::to_string(i));
    std::map<std::string, std::string> tokens;
    const std::string controller = "org.example.controller";
    std::string a, b, ta, tb, tc;
    {
        Server server(tmp.path, {"--map-cache", "keep"});
        const auto call = [&](const std::string& method, const std::string& route, std::optional<json> data = none, const std::string& token = "", Headers headers = {}) {
            return server.call(method, route, data, token, headers);
        };
        // Several applications, registered concurrently, each with its own token.
        std::vector<std::future<Reply>> made;
        for (const auto& id : ids) made.push_back(std::async(std::launch::async, [&, id] { return call("POST", BASE, manifest(id)); }));
        std::set<std::string> distinct;
        for (std::size_t i = 0; i < ids.size(); ++i) {
            const auto reply = made[i].get();
            EXPECT(reply.status == 201, reply);
            tokens[ids[i]] = reply.data().at("token");
            distinct.insert(tokens[ids[i]]);
        }
        EXPECT(distinct.size() == 12);
        std::set<std::string> listed;
        for (const auto& app : json(call("GET", BASE).data().at("items"))) {
            listed.insert(app.at("id"));
            EXPECT(!app.contains("token"));
        }
        EXPECT(listed == std::set<std::string>(ids.begin(), ids.end()), json(listed));
        a = ids[0], b = ids[1], ta = tokens[a], tb = tokens[b];

        // Identity: a live ID cannot be taken, reserved names cannot be used.
        EXPECT(call("POST", BASE, manifest(a)).code() == "APP_ID_CONFLICT");
        EXPECT(call("POST", BASE, manifest(a, {{"version", "1.1.0"}}), ta).status == 201, "the owner may update");
        const std::vector<std::pair<json, std::string>> bad_manifests = {
            {{{"id", "dstns.thing"}, {"name", "x"}, {"version", "1"}}, "APP_ID_RESERVED"},
            {{{"id", "org.x.y"}, {"name", "WebFabric"}, {"version", "1"}}, "APP_NAME_RESERVED"},
            {{{"id", "../x"}, {"name", "x"}, {"version", "1"}}, "INVALID_MANIFEST"},
            {{{"id", "org.x.y"}, {"name", "x"}, {"version", "1"}, {"capabilities", {"root"}}}, "INVALID_MANIFEST"},
            {{{"id", "org.x.y"}, {"name", "x"}, {"version", "1"}, {"requires_api", 2}}, "APP_INCOMPATIBLE"},
            {{{"id", "org.x.y"}, {"name", "x"}, {"version", "1"}, {"settings", {{"groups", {{{"id", "g"}, {"label", "G"}, {"fields", {{{"id", "f"}, {"label", "F"}, {"type", "toggle"}, {"default", "yes"}}}}}}}}}}, "INVALID_MANIFEST"},
        };
        for (const auto& [bad, expected] : bad_manifests) EXPECT(call("POST", BASE, bad).code() == expected, bad);

        // Authentication: another application's token is worthless.
        EXPECT(call("POST", BASE + "/" + a + "/heartbeat", json::object(), tb).code() == "APP_TOKEN_INVALID");
        EXPECT(call("POST", BASE + "/" + a + "/heartbeat", json::object()).code() == "APP_TOKEN_INVALID");
        EXPECT(call("POST", BASE + "/" + a + "/heartbeat", json::object(), ta).status == 200);
        EXPECT(call("GET", BASE + "/" + a).data().at("state") == "active");

        // Settings: validated, atomic, namespaced.
        const auto settings = BASE + "/" + a + "/settings";
        EXPECT(call("PUT", settings, json{{"level", 7}}, ta).data().at("values").at("level") == 7);
        EXPECT(call("GET", BASE + "/" + b + "/settings", none, tb).data().at("values").at("level") == 5, "b is untouched");
        EXPECT(call("GET", settings, none, tb).code() == "APP_TOKEN_INVALID", "b cannot read a");
        EXPECT(call("PUT", settings, json{{"level", 1}}, tb).code() == "APP_TOKEN_INVALID", "b cannot write a");
        EXPECT(call("GET", settings).code() == "APP_TOKEN_INVALID");
        for (const json& bad_change : {json{{"level", 11}}, json{{"level", "high"}}, json{{"mode", "c"}}, json{{"name", "far too long"}}, json{{"enabled", 1}}, json{{"unknown", 1}}}) {
            EXPECT(call("PUT", settings, bad_change, ta).code() == "INVALID_SETTINGS", bad_change);
        }
        EXPECT(call("PUT", settings, json{{"mode", "b"}, {"level", 99}}, ta).code() == "INVALID_SETTINGS");
        EXPECT(call("GET", settings, none, "", HOST).data().at("values").at("mode") == "a", "nothing applied from a refused change");
        EXPECT(call("PUT", settings, json{{"mode", "b"}}, "", HOST).status == 200);
        bool told = false;
        for (const auto& e : json(call("GET", BASE + "/" + a + "/events", none, ta).data().at("items"))) {
            told = told || (e.at("type") == "settings.changed" && e.at("data").at("changes") == json{{"mode", "b"}});
        }
        EXPECT(told, "changes reach the app without a restart");
        EXPECT(call("DELETE", settings, none, "", HOST).data().at("values").at("mode") == "a");
        EXPECT(call("PUT", settings, json{{"level", 8}}, ta).status == 200);

        // Capabilities: requested in the manifest, then granted.
        EXPECT(call("PUT", BASE + "/" + a + "/ui/x", json{{"slot", "dialog"}, {"title", "t"}}, ta).code() == "CAPABILITY_NOT_REQUESTED");
        EXPECT(call("POST", BASE + "/" + a + "/control", json{{"action", "pause"}}, ta).code() == "CAPABILITY_NOT_GRANTED");
        tc = call("POST", BASE, manifest(controller, {{"capabilities", {"ui.status", "control.playback", "control.events", "ui.dialogs", "ui.frames", "ui.panels"}}})).data().at("token");
        const auto ctl = BASE + "/" + controller;
        EXPECT(call("POST", ctl + "/control", json{{"action", "pause"}}, tc).code() == "CAPABILITY_NOT_GRANTED", "control is never automatic");
        EXPECT(call("PUT", ctl + "/grants", json{{"capabilities", {"control.playback"}}}, tc).code() == "HOST_REQUIRED", "an app cannot grant itself");
        const Headers evil = {{"Origin", "null"}, {"X-DSTNS-Host", "observer"}};
        EXPECT(call("PUT", ctl + "/grants", json{{"capabilities", {"control.playback"}}}, "", evil).status == 403, "a sandboxed frame cannot grant");
        EXPECT(call("GET", ctl + "/settings", none, "", evil).status == 401, "a sandboxed frame cannot read settings");
        EXPECT(call("PUT", ctl + "/grants", json{{"capabilities", {"root"}}}, "", server.host).code() == "CAPABILITY_NOT_REQUESTED");

        // Control: granted, audited, and only what the capability covers.
        const auto started = server.op("POST", "/api/v1/playback/start", json{{"seed", "12345"}, {"playback_duration_seconds", 3600}, {"map", {{"osm_file", "tests/fixtures/roads.osm.xml"}}}});
        EXPECT(started.status == 202, started);
        until_running(server, 15);
        EXPECT(call("PUT", ctl + "/grants", json{{"capabilities", {"ui.status", "control.playback"}}}, "", HOST).status == 200);
        EXPECT(call("POST", ctl + "/control", json{{"action", "pause"}}, tc).status == 200);
        EXPECT(call("GET", "/api/v1/playback/status").data().at("lifecycle") == "PAUSED");
        EXPECT(call("POST", ctl + "/control", json{{"action", "surge"}, {"params", {{"node_id", 0}}}}, tc).code() == "CAPABILITY_NOT_GRANTED");
        EXPECT(call("POST", ctl + "/control", json{{"action", "terminate"}}, tc).code() == "UNKNOWN_ACTION", "shutdown is never offered");
        EXPECT(call("POST", ctl + "/control", json{{"action", "seek"}, {"params", {{"target_time", 90000}}}}, tc).status == 400);
        const auto audit = call("GET", "/api/v1/fabric/audit").data().at("items");
        EXPECT(audit.size() == 2 && audit[0].at("action") == "pause" && audit[1].at("action") == "seek" && audit[0].at("app_id") == controller && !audit[0].at("run_id").empty(), audit);
        EXPECT(audit[1].at("outcome").get<std::string>().starts_with("refused"));

        // Bus stops of an application's own carry the core's demand model, read-only.
        auto network = call("GET", "/api/v1/view/topology").body;
        if (network.contains("data")) network = network["data"];
        const auto node = network.at("nodes")[0].at("id");
        const auto before_status = call("GET", "/api/v1/playback/status").data().at("lifecycle");
        const auto stops = BASE + "/" + a + "/stops";
        const auto placed = call("PUT", stops, json{{"nodes", {node}}}, ta);
        EXPECT(placed.status == 200 && placed.data().at("items")[0].at("node") == node, placed);
        EXPECT(placed.data().at("items")[0].at("multiplier") > 0);
        EXPECT(call("GET", stops, none, ta).data().at("items")[0].at("node") == node);
        EXPECT(call("GET", stops, none, tb).code() == "APP_TOKEN_INVALID");
        EXPECT(call("PUT", stops, json{{"nodes", {"x"}}}, ta).code() == "INVALID_STOPS");
        EXPECT(call("PUT", stops, json{{"nodes", {100000000}}}, ta).status == 404);
        EXPECT(call("GET", "/api/v1/playback/status").data().at("lifecycle") == before_status);
        EXPECT(call("PUT", stops, json{{"nodes", json::array()}}, ta).status == 200);

        // How an element arrives: a provided motion, or a spring within the guidelines.
        const auto m = BASE + "/" + a + "/ui/m";
        for (const json& good : {json("rise"), json("pop"), json{{"stiffness", 300}, {"damping", 28}}}) {
            EXPECT(call("PUT", m, json{{"slot", "status"}, {"label", "M"}, {"motion", good}}, ta).status == 200, good);
        }
        for (const json& bad : {json("wobble"), json{{"stiffness", 300}, {"damping", 5}}, json{{"stiffness", 40}, {"damping", 80}}, json{{"stiffness", 5000}, {"damping", 200}}, json{{"damping", 20}}}) {
            EXPECT(call("PUT", m, json{{"slot", "status"}, {"label", "M"}, {"motion", bad}}, ta).code() == "INVALID_ELEMENT", bad);
        }
        EXPECT(call("DELETE", m, none, ta).status == 200);

        // Declared UI: slots, tones and frames are checked; a frame needs its grant.
        const auto ui = BASE + "/" + a + "/ui";
        EXPECT(call("PUT", ui, json::array({{{"id", "s"}, {"slot", "status"}, {"tone", "#ff0000"}}}), ta).code() == "INVALID_ELEMENT", "no colours");
        EXPECT(call("PUT", ui, json::array({{{"id", "s"}, {"slot", "nowhere"}}}), ta).code() == "INVALID_ELEMENT");
        EXPECT(call("PUT", ui, json::array({{{"id", "s"}, {"slot", "status"}}, {{"id", "s"}, {"slot", "status"}}}), ta).code() == "INVALID_ELEMENT");
        EXPECT(call("PUT", ui, json::array({{{"id", "s"}, {"slot", "status"}, {"label", "Load"}, {"value", "1"}, {"tone", "ok"}}}), ta).status == 200);
        const auto before = call("GET", "/api/v1/fabric/state").data();
        EXPECT(before.at("unchanged") == false);
        EXPECT(call("GET", "/api/v1/fabric/state?since=" + before.at("revision").dump()).data().at("unchanged") == true, "an idle poll costs nothing");
        EXPECT(call("PUT", ctl + "/ui/f", json{{"slot", "panel"}, {"frame", "javascript:alert(1)"}}, tc).code() == "INVALID_ELEMENT");
        EXPECT(call("PUT", ctl + "/ui/f", json{{"slot", "panel"}, {"title", "F"}, {"frame", "https://app.example/"}}, tc).status == 200);
        const auto view = call("GET", ctl).data();
        EXPECT(view.at("blocked_ui") == json::array({"f"}) && view.at("ui").empty(), "an ungranted frame is not offered to the page");

        // High-frequency updates coalesce into the latest state, concurrently.
        std::vector<std::future<int>> updates;
        for (int worker = 0; worker < 8; ++worker) {
            updates.push_back(std::async(std::launch::async, [&, worker] {
                int worst = 200;
                for (int n = worker; n < 200; n += 8) {
                    const auto status = call("PUT", BASE + "/" + b + "/ui/s", json{{"slot", "status"}, {"label", "Tick"}, {"value", std::to_string(n)}}, tb).status;
                    if (status != 200) worst = status;
                }
                return worst;
            }));
        }
        for (auto& update : updates) EXPECT(update.get() == 200);
        for (const auto& app : json(call("GET", "/api/v1/fabric/state").data().at("apps"))) {
            if (app.at("id") == b) EXPECT(app.at("ui").size() == 1, "200 updates are one element");
        }

        // After the first poll, only what changed comes back.
        auto mark = call("GET", "/api/v1/fabric/state").data().at("revision").dump();
        EXPECT(call("PUT", BASE + "/" + b + "/ui/other", json{{"slot", "status"}, {"label", "Other"}}, tb).status == 200);
        EXPECT(call("PUT", BASE + "/" + b + "/ui/s", json{{"slot", "status"}, {"label", "Tick"}, {"value", "x"}}, tb).status == 200);
        auto patch = call("GET", "/api/v1/fabric/state?since=" + mark).data();
        EXPECT(patch.at("apps").size() == 1 && patch.at("apps")[0].at("id") == b, patch.at("apps"));
        std::set<std::string> patched;
        for (const auto& e : patch.at("apps")[0].at("ui_patch")) patched.insert(e.at("id"));
        EXPECT((patched == std::set<std::string>{"other", "s"}) && !patch.at("apps")[0].contains("ui"));
        EXPECT(patch.at("apps")[0].at("ui_order") == json::array({"s", "other"}));
        mark = patch.at("revision").dump();
        EXPECT(call("PUT", BASE + "/" + b + "/ui/s", json{{"slot", "status"}, {"label", "Tick"}, {"value", "y"}}, tb).status == 200);
        patch = call("GET", "/api/v1/fabric/state?since=" + mark).data();
        EXPECT(patch.at("apps")[0].at("ui_patch").size() == 1 && patch.at("apps")[0].at("ui_patch")[0].at("id") == "s", "one element, not the application's whole UI");
        EXPECT(call("DELETE", BASE + "/" + b + "/ui/other", none, tb).status == 200);

        // Notifications are never lost silently: delivered in order or refused.
        std::vector<std::string> sent;
        int refused = 0;
        for (int n = 0; n < 120; ++n) {
            const auto r = call("POST", BASE + "/" + b + "/notifications", json{{"title", "n" + std::to_string(n)}, {"severity", "info"}}, tb);
            if (r.status == 202) sent.push_back("n" + std::to_string(n));
            else {
                EXPECT(r.code() == "RATE_LIMITED", r);
                ++refused;
            }
        }
        EXPECT(refused > 0, "a flood meets the rate limit");
        std::vector<std::string> seen;
        for (std::string cursor = "0";;) {
            const auto page = call("GET", "/api/v1/fabric/state?since=0&notifications_since=" + cursor).data();
            if (page.at("notifications").empty()) break;
            for (const auto& note : page.at("notifications")) {
                if (note.at("app_id") == b) seen.push_back(note.at("title"));
            }
            cursor = page.at("notifications").back().at("sequence").dump();
        }
        EXPECT(seen == sent);
        EXPECT(call("POST", BASE + "/" + a + "/notifications", json{{"title", ""}}, ta).code() == "INVALID_NOTIFICATION");

        // A viewer's action reaches only its own application, in order.
        for (int n = 0; n < 5; ++n) EXPECT(call("POST", BASE + "/" + a + "/actions", json{{"element", "s"}, {"value", n}}, "", HOST).status == 202);
        EXPECT(call("POST", BASE + "/" + a + "/actions", json{{"element", "s"}}, ta).status == 403);
        json actions = json::array();
        for (const auto& e : json(call("GET", BASE + "/" + a + "/events", none, ta).data().at("items"))) {
            if (e.at("type") == "ui.action") actions.push_back(e.at("data").at("value"));
        }
        EXPECT(actions == json::array({0, 1, 2, 3, 4}), actions);
        for (const auto& e : json(call("GET", BASE + "/" + b + "/events", none, tb).data().at("items"))) EXPECT(e.at("type") != "ui.action");

        // One application failing or being suspended leaves the others alone.
        EXPECT(call("POST", BASE + "/" + b + "/failure", json{{"detail", "frame crashed"}}, "", HOST).status == 200);
        std::map<std::string, json> apps;
        for (const auto& app : json(call("GET", "/api/v1/fabric/state").data().at("apps"))) apps[app.at("id")] = app;
        EXPECT(apps[b].at("state") == "failed" && apps[b].at("ui").empty() && !apps[a].at("ui").empty());
        EXPECT(call("POST", BASE + "/" + b + "/notifications", json{{"title", "x"}}, tb).code() == "APP_NOT_ACTIVE");
        EXPECT(call("PUT", BASE + "/" + b + "/state", json{{"state", "active"}}, tb).status == 200, "an application can recover");
        EXPECT(call("POST", BASE + "/" + a + "/suspend", json::object(), "", HOST).status == 200);
        EXPECT(call("GET", BASE + "/" + a).data().at("ui").empty());
        EXPECT(call("PUT", BASE + "/" + a + "/state", json{{"state", "active"}}, ta).code() == "APP_SUSPENDED", "only the person resumes it");
        EXPECT(call("POST", BASE + "/" + a + "/resume", json::object(), "", HOST).status == 200);
        EXPECT(!call("GET", BASE + "/" + a).data().at("ui").empty());

        // Leases: silence suspends, a call recovers, longer silence unloads.
        const std::string short_id = "org.example.short";
        const auto ts = call("POST", BASE, manifest(short_id, {{"lease_s", 1}})).data().at("token").get<std::string>();
        EXPECT(call("PUT", BASE + "/" + short_id + "/ui/s", json{{"slot", "status"}, {"label", "L"}}, ts).status == 200);
        EXPECT(call("POST", BASE + "/" + short_id + "/heartbeat", json::object(), ts).status == 200);
        delay(1.3);
        const auto lapsed = call("GET", BASE + "/" + short_id).data();
        EXPECT(lapsed.at("state") == "suspended" && lapsed.at("ui").empty(), lapsed);
        EXPECT(call("POST", BASE + "/" + short_id + "/heartbeat", json::object(), ts).status == 200);
        EXPECT(call("GET", BASE + "/" + short_id).data().at("state") == "active");
        delay(5.3);
        EXPECT(call("GET", BASE + "/" + short_id).data().at("state") == "unloaded");
        EXPECT(call("POST", BASE + "/" + short_id + "/heartbeat", json::object(), ts).code() == "APP_NOT_ACTIVE");
        EXPECT(call("POST", BASE, manifest(short_id)).status == 201, "an unprivileged ID that left can return");

        // Unregistering keeps identity; forgetting is a person's act.
        EXPECT(call("DELETE", BASE + "/" + ids[2], none, tokens[ids[2]]).status == 200);
        EXPECT(call("GET", BASE + "/" + ids[2]).data().at("state") == "unloaded");
        EXPECT(call("DELETE", BASE + "/" + ids[3], none, tb).code() == "APP_TOKEN_INVALID");
        mark = call("GET", "/api/v1/fabric/state").data().at("revision").dump();
        EXPECT(call("DELETE", BASE + "/" + ids[4], none, "", HOST).status == 200);
        EXPECT(call("GET", BASE + "/" + ids[4]).status == 404);
        EXPECT(call("GET", "/api/v1/fabric/state?since=" + mark).data().at("removed") == json::array({ids[4]}), "the observer learns it has gone");
        EXPECT(call("PUT", BASE + "/" + b + "/settings", json{{"mode", "b"}}, tb).status == 200);
    }
    // ./launcher reset app-settings ID asks, and the next start does it: b's settings go back to their defaults.
    std::ofstream(tmp / "fabric-apps.json.reset") << b << "\n";

    // A restart: identity, grants and settings persist; run-time UI does not.
    Server server(tmp.path, {"--map-cache", "keep"});
    const auto call = [&](const std::string& method, const std::string& route, std::optional<json> data = none, const std::string& token = "", Headers headers = {}) {
        return server.call(method, route, data, token, headers);
    };
    EXPECT(call("GET", BASE + "/" + a).data().at("state") == "unloaded");
    // Unloaded, it has no interface to change until it registers again: nothing it drew would be seen.
    const auto stale = call("PUT", BASE + "/" + a + "/ui/late", json{{"slot", "status"}, {"label", "Late"}, {"value", "1"}}, ta);
    EXPECT(stale.status == 409 && stale.code() == "APP_NOT_ACTIVE", stale);
    EXPECT(call("POST", BASE, manifest(controller, {{"capabilities", {"control.playback"}}})).code() == "APP_ID_CONFLICT", "granted IDs need their token");
    const auto back = call("POST", BASE, manifest(controller, {{"capabilities", {"ui.status", "control.playback"}}}), tc);
    const auto granted = back.data().at("app").at("capabilities").at("granted");
    EXPECT(back.status == 201 && std::find(granted.begin(), granted.end(), "control.playback") != granted.end(), back);
    EXPECT(call("POST", BASE, manifest(a), ta).data().at("token") == ta);
    EXPECT(call("GET", BASE + "/" + a + "/settings", none, ta).data().at("values").at("level") == 8);
    EXPECT(call("GET", BASE + "/" + b + "/settings", none, tb).data().at("values").at("mode") == "a", "reset to its default");
    EXPECT(!std::filesystem::exists(tmp / "fabric-apps.json.reset"), "a request is done once");

    // Schema migration: renames applied, invalid values reset, the app told.
    auto migrated = manifest(a);
    migrated["settings"]["version"] = 2;
    migrated["settings"]["migrations"] = {{"1", {{"rename", {{"level", "intensity"}}}}}};
    auto& fields = migrated["settings"]["groups"][0]["fields"];
    fields[1]["id"] = "intensity";
    fields[1]["max"] = 9;
    fields.push_back({{"id", "extra"}, {"label", "Extra"}, {"type", "number"}, {"default", 2}});
    EXPECT(call("POST", BASE, migrated, ta).status == 201);
    const auto values = call("GET", BASE + "/" + a + "/settings", none, ta).data();
    EXPECT(values.at("version") == 2 && values.at("values").at("intensity") == 8 && values.at("values").at("extra") == 2 && !values.at("values").contains("level"), values);
    bool migrated_event = false;
    for (const auto& e : json(call("GET", BASE + "/" + a + "/events", none, ta).data().at("items"))) migrated_event = migrated_event || e.at("type") == "settings.migrated";
    EXPECT(migrated_event);

    // A whole world for overlays: features tied to the road network are checked against it.
    EXPECT(server.op("POST", "/api/v1/playback/start", json{{"seed", "12345"}, {"playback_duration_seconds", 3600}, {"map", {{"osm_file", "data/fixtures/real_network.osm.xml"}}}}).status == 202);
    until_running(server, 30);
    const auto net = call("POST", BASE, manifest("org.test.network", {{"capabilities", {"ui.overlays"}}})).data().at("token").get<std::string>();
    auto topology = call("GET", "/api/v1/view/topology").body;
    if (topology.contains("data")) topology = topology["data"];
    const auto edge = topology.at("edges")[0];
    const json joined = {edge.at("from"), edge.at("to")};
    const auto place = [&](const json& feature) { return call("PUT", BASE + "/org.test.network/ui/over", json{{"slot", "overlay"}, {"features", {feature}}}, net); };
    EXPECT(place({{"type", "marker"}, {"node", edge.at("from")}, {"shape", "stop"}}).status == 200);
    EXPECT(place({{"type", "entity"}, {"edge", edge.at("id")}, {"at", 0.5}, {"shape", "bus"}}).status == 200);
    EXPECT(place({{"type", "route"}, {"nodes", joined}}).status == 200);
    EXPECT(place({{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"loop", true}, {"speed_mps", 40}, {"spring", "lively"}}).status == 200);
    EXPECT(place({{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"spring", {{"stiffness", 300}, {"damping", 30}}}}).status == 200);
    EXPECT(place({{"type", "marker"}, {"node", 99999999}}).status == 422);
    EXPECT(place({{"type", "entity"}, {"edge", 99999999}}).status == 422);
    std::set<long long> connected{edge.at("from").get<long long>()};
    for (const auto& e : topology.at("edges")) {
        if (e.at("from") == edge.at("from")) connected.insert(e.at("to").get<long long>());
    }
    json stranger;
    for (const auto& n : topology.at("nodes")) {
        if (!connected.contains(n.at("id").get<long long>())) {
            stranger = n.at("id");
            break;
        }
    }
    const auto refused = place({{"type", "route"}, {"nodes", {edge.at("from"), stranger}}});
    EXPECT(refused.status == 422 && refused.code() == "NOT_ON_NETWORK", refused);
    for (const json& wrong : {json{{"type", "path"}, {"id", "p"}, {"nodes", {edge.at("from")}}}, json{{"type", "path"}, {"nodes", joined}},
                              json{{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"speed_mps", 0}}}) {
        EXPECT(place(wrong).status == 400, wrong);
    }
    // Drawing along the road, and driving it as the map's own traffic does.
    EXPECT(place({{"type", "route"}, {"nodes", joined}, {"draw_s", 2.5}}).status == 200);
    EXPECT(place({{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"draw_s", 2}, {"shape", "none"}}).status == 200);
    EXPECT(place({{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"drive", true}, {"count", 4}, {"spacing_m", 20}, {"obey_signals", false}}).status == 200);
    for (const json& wrong : {json{{"type", "route"}, {"nodes", joined}, {"draw_s", 0}}, json{{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"drive", "yes"}},
                              json{{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"count", 13}}, json{{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"spacing_m", 1}},
                              json{{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"spring", "wobbly"}},
                              json{{"type", "path"}, {"id", "p"}, {"nodes", joined}, {"spring", {{"stiffness", 300}, {"damping", 2}}}},
                              json{{"type", "entity"}, {"edge", edge.at("id")}, {"at", 2}}, json{{"type", "marker"}, {"node", edge.at("from")}, {"shape", "logo"}}}) {
        EXPECT(place(wrong).status == 400, wrong);
    }
    EXPECT(place({{"type", "route"}, {"nodes", {edge.at("from"), stranger}}, {"draw_s", 2}}).status == refused.status, "drawing does not get round adjacency");

    // The bus planner example, a whole product on Fabric, where there is a Python to run it with.
    if (which("python3") != "python3") {
        const auto demo = run({"python3", (root() / "Fabric/examples/bus_planner.py").string(), "--url", "http://127.0.0.1:" + std::to_string(server.port), "--ticks", "3"}, {}, 60);
        EXPECT(demo.code == 0 && demo.output.starts_with("ok:"), demo.output);
    }

    // Credentials stay private on disk, and the existing API is untouched.
    struct stat info {};
    ::stat((tmp / "fabric-apps.json").c_str(), &info);
    EXPECT((info.st_mode & 0777) == 0600, info.st_mode & 0777);
    EXPECT(call("GET", "/health").status == 200);
    bool fabric_group = false;
    for (const auto& group : json(call("GET", "/api/v1/system/endpoints").body.at("groups"))) fabric_group = fabric_group || group.at("group") == "fabric";
    EXPECT(fabric_group);
    EXPECT(call("GET", "/api/v1/system/source").body.at("api_version") == "1.13");
    std::cout << "fabric apps ok\n";
}
