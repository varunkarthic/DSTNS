// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Hostile values at every route that takes any, against a real server and a real world.
//
// A wrong request gets a 4xx with a code. It never gets a 5xx, and it never takes the server down.
#include "harness.hpp"
#include "support.hpp"

using namespace check;

namespace {

const std::string BASE = "/api/v1/fabric/apps";

// As JSON text, since some are more than a JSON library would hold: 2^64, for one.
const std::vector<std::string> VALUES = {
    "null", "true", "-1", "0", "1", "1.5", "1e308", "-1e308", "18446744073709551616", "-9223372036854775808", "\"\"", "\"x\"",
    "\"../../etc/passwd\"", "\"\\u0000\"", [] {
        std::string text = "\"";
        for (int i = 0; i < 300; ++i) text += "\\ud7ff";
        return text + "\"";
    }(),
    "[]", "[[]]", "{}", "{\"a\":{}}", "[1,2,3]"};

// `base` with `field` set to `value`, as text.
std::string with(json base, const std::string& field, const std::string& value) {
    base[field] = "\x01placeholder\x01";
    auto text = base.dump();
    const std::string marker = json("\x01placeholder\x01").dump();
    return text.replace(text.find(marker), marker.size(), value);
}

// Each of these was once possible.
void protections(const Server& server, const std::string& token) {
    // Only the operator writes outside data/.
    for (const char* directory : {"/tmp/dstns-nope", "../dstns-nope", "data/../../dstns-nope", "logs/x", ""}) {
        const auto reply = server.call("POST", "/api/v1/export/sumo", json{{"directory", directory}});
        EXPECT(reply.status == 403 && reply.code() == "DIRECTORY_NOT_ALLOWED", directory, reply);
    }
    // Nothing may frame the observer, or sniff what it serves.
    const auto page = server.call("GET", "/");
    EXPECT(page.header("X-Frame-Options") == "DENY" && page.header("X-Content-Type-Options") == "nosniff");
    if (!page.header("Content-Security-Policy").empty()) EXPECT(contains(page.header("Content-Security-Policy"), "frame-ancestors 'none'"));

    // A response is signed only for a request that really was: no signatures for the asking.
    const std::string app_id = "org.test.signed";
    const auto made = server.call("POST", BASE, json{{"id", app_id}, {"name", "Signed"}, {"version", "1.0.0"}, {"security", {{"require_signatures", true}}}}).data();
    const auto route = BASE + "/" + app_id;
    const auto forged = server.call("GET", route, none, "", {{"X-DSTNS-Signature", std::string(64, '0')}, {"X-DSTNS-Nonce", "chosen-by-me"}, {"X-DSTNS-Timestamp", "1"}});
    EXPECT(forged.header("X-DSTNS-Response-Signature").empty(), "a forged request gets nothing signed");
    const auto signed_call = [&](const std::string& method, const std::string& target, std::optional<json> payload = none) {
        const std::string text = payload ? payload->dump() : "";
        const auto moment = std::to_string(std::time(nullptr));
        const auto nonce = random_hex(8);
        const auto signature = dstns::fabric::hmac_sha256(made.at("signing_key").get<std::string>(), method + "\n" + target + "\n" + moment + "\n" + nonce + "\n" + sha256_hex(text));
        return server.raw(method, target, text,
                          {{"Authorization", "Bearer " + made.at("token").get<std::string>()}, {"X-DSTNS-Timestamp", moment}, {"X-DSTNS-Nonce", nonce}, {"X-DSTNS-Signature", signature}});
    };
    const auto good = signed_call("POST", route + "/heartbeat");
    EXPECT(good.status == 200 && !good.header("X-DSTNS-Response-Signature").empty(), "a real one does", good);
    // Nor can a stolen token turn signing off by registering again without it.
    const auto stolen = server.call("POST", BASE, json{{"id", app_id}, {"name", "Signed"}, {"version", "2.0.0"}}, made.at("token"));
    EXPECT(stolen.status == 401 && stolen.code() == "SIGNATURE_REQUIRED", stolen);
    EXPECT(signed_call("POST", BASE, json{{"id", app_id}, {"name", "Signed"}, {"version", "2.0.0"}, {"security", {{"require_signatures", true}}}}).status == 201);

    // Taking up an ID someone left doesn't hand over what it kept, or what it was sent.
    const json leaves{{"id", "org.test.leaves"}, {"name", "Leaves"}, {"version", "1.0.0"}, {"capabilities", {"storage"}}};
    const auto token_a = server.call("POST", BASE, leaves).data().at("token").get<std::string>();
    const auto place = BASE + "/org.test.leaves";
    EXPECT(server.call("PUT", place + "/storage/secret", json{{"value", "mine"}}, token_a).status == 200);
    EXPECT(server.call("DELETE", place, none, token_a).status == 200);
    const auto token_b = server.call("POST", BASE, leaves).data().at("token").get<std::string>();
    EXPECT(token_b != token_a && server.call("GET", place + "/storage/secret", none, token_b).status == 404, "storage is the application's own");
    EXPECT(server.call("GET", place + "/storage", none, token_a).status == 401, "and the old token is finished");

    // The record says what was asked, not everything sent.
    const auto control = server.call("POST", BASE + "/org.test.fuzz/control", json{{"action", "pause"}, {"params", {{"junk", std::string(100000, 'x')}}}}, token).status;
    EXPECT(control == 200 || control == 400 || control == 409, control);
    const auto last = server.call("GET", "/api/v1/fabric/audit?limit=1").data().at("items").back();
    EXPECT(last.at("params") == (json{{"truncated", true}}), last);

    // Places for applications can't be used up for good by programs that have gone.
    for (int n = 0; n < 70; ++n) {
        const auto identity = "org.test.gone" + std::to_string(n);
        const auto made_n = server.call("POST", BASE, json{{"id", identity}, {"name", "Gone " + std::to_string(n)}, {"version", "1.0.0"}});
        EXPECT(made_n.status == 201, n, made_n);
        EXPECT(server.call("DELETE", BASE + "/" + identity, none, made_n.data().at("token")).status == 200);
    }
}

} // namespace

int main() {
    TempDir tmp;
    Server server(tmp.path);
    const auto started = server.op("POST", "/api/v1/playback/start", json{{"seed", "10775"}, {"playback_duration_seconds", 600}, {"map", {{"osm_file", "data/fixtures/real_network.osm.xml"}}}});
    EXPECT(started.status == 202, started);
    until([&] { return server.call("GET", "/api/v1/playback/status").data().at("lifecycle") == "RUNNING"; }, 40, "the run");
    const json capabilities = {"ui.camera", "ui.layers", "ui.overlays", "ui.panels", "ui.notifications", "settings", "sim.read", "storage", "apps.messages", "control.playback", "control.events"};
    const auto token = server.call("POST", BASE, json{{"id", "org.test.fuzz"}, {"name", "Fuzz"}, {"version", "1.0.0"}, {"capabilities", capabilities}}).data().at("token").get<std::string>();
    EXPECT(server.op("PUT", BASE + "/org.test.fuzz/grants", json{{"capabilities", capabilities}}).status == 200);
    const auto app = BASE + "/org.test.fuzz";

    struct Route {
        std::string method, route;
        std::vector<std::string> fields;
        json base;
    };
    // Field by field: every value in every field a route reads.
    const std::vector<Route> routes = {
        {"POST", "/api/v1/control/events/weather", {"epicenter_node", "intensity", "radius_m", "duration_virtual_minutes", "flood_gain"}, {{"epicenter_node", 0}}},
        {"POST", "/api/v1/control/events/traffic", {"target", "congestion_pressure"}, {{"target", {{"type", "edge"}, {"id", 0}}}, {"congestion_pressure", 0.5}}},
        {"POST", "/api/v1/control/events/surge", {"node_id", "factor", "radius_m", "duration_s"}, {{"node_id", 0}}},
        {"PUT", "/api/v1/control/edges/0", {"speed_multiplier", "capacity_multiplier", "closed"}, json::object()},
        {"PUT", "/api/v1/control/tick-rate", {"tick_rate"}, {{"tick_rate", 1}}},
        {"POST", "/api/v1/control/day", {"day"}, {{"day", 1}}},
        {"PUT", "/api/v1/control/modules/traffic", {"enabled"}, {{"enabled", true}}},
        {"POST", "/api/v1/control/undo", {"count"}, json::object()},
        {"POST", "/api/v1/control/redo", {"count"}, json::object()},
        {"POST", "/api/v1/playback/seek", {"target_time", "play"}, {{"target_time", 60}}},
        {"POST", "/api/v1/playback/step", {"seconds"}, json::object()},
        {"POST", "/api/v1/playback/play", {"rate", "tick_rate"}, json::object()},
        {"POST", "/api/v1/playback/pause", {"reason"}, json::object()},
        {"POST", "/api/v1/system/backpressure", {"virtual_lag_s", "client_frame_s", "since_poll_s", "away"}, json::object()},
        {"POST", "/api/v1/system/observer", {"waiting"}, json::object()},
        {"POST", "/api/v1/export/sumo", {"directory"}, json::object()},
        {"POST", "/api/v1/system/sumo-simulate", {"begin_s", "end_s"}, {{"directory", "data/sumo_fuzz"}}},
        {"POST", BASE, {"id", "name", "version", "capabilities", "ui", "settings", "lease_s", "frame_origins", "security"}, {{"id", "org.test.other"}, {"name", "Other"}, {"version", "1.0.0"}}},
        {"PUT", app + "/state", {"state", "detail"}, {{"state", "active"}}},
        {"PUT", app + "/ui/thing", {"slot", "title", "widgets", "features", "motion", "frame"}, {{"slot", "panel"}}},
        {"POST", app + "/notifications", {"title", "body", "severity", "actions"}, {{"title", "x"}}},
        {"PUT", app + "/settings", {"anything"}, json::object()},
        {"PUT", app + "/subscriptions", {"topics"}, {{"topics", json::array()}}},
        {"PUT", app + "/timers/t", {"at_s", "every_s", "data"}, {{"at_s", 10}}},
        {"PUT", app + "/storage/k", {"value"}, {{"value", 1}}},
        {"POST", app + "/messages", {"to", "type", "data"}, {{"to", "org.test.fuzz"}}},
        {"PUT", app + "/stops", {"nodes"}, {{"nodes", {0}}}},
        {"POST", app + "/view", {"action", "x_m", "y_m", "span_m", "node", "edge", "factor"}, {{"action", "focus"}, {"x_m", 0}, {"y_m", 0}}},
        {"PUT", app + "/presentation", {"layers", "places"}, json::object()},
        {"POST", app + "/control", {"action", "params"}, {{"action", "pause"}}},
        {"PUT", app + "/launch", {"commands", "cwd", "env", "ready"}, {{"commands", {"x"}}}},
    };
    std::vector<std::string> problems;
    for (const auto& [method, route, fields, base] : routes) {
        // Never as the operator where a path is taken: that is allowed to write wherever it says.
        const bool as_operator = !route.starts_with(app) && !contains(route, "sumo");
        Headers headers{{"Authorization", "Bearer " + token}};
        if (as_operator) headers.insert(server.host.begin(), server.host.end());
        for (const auto& field : fields) {
            for (const auto& value : VALUES) {
                try {
                    const auto code = server.raw(method, route, with(base, field, value), headers).status;
                    // 503 says a tool outside the server failed, which is not a fault in the request's handling.
                    if (code >= 500 && code != 503) problems.push_back(method + " " + route + " " + field + "=" + value.substr(0, 40) + ": " + std::to_string(code));
                } catch (const std::exception& error) {
                    problems.push_back(method + " " + route + " " + field + "=" + value.substr(0, 40) + ": " + error.what());
                }
            }
        }
        // Whatever those left behind, the run carries on.
        server.call("POST", "/api/v1/playback/pause", json::object());
    }

    // Bodies that are not what they say.
    const std::string deep = std::string(200000, '[') + std::string(200000, ']');
    std::string deep_object;
    for (int i = 0; i < 100000; ++i) deep_object += "{\"a\":";
    deep_object += "1" + std::string(100000, '}');
    for (const auto& route : {std::string("/api/v1/control/undo"), BASE, app + "/storage/k", app + "/ui/thing"}) {
        const std::string method = route.ends_with("/k") || route.ends_with("/thing") ? "PUT" : "POST";
        for (const auto& payload : {std::string(""), std::string("{"), std::string("\xff\xfe"), std::string("null"), std::string("[]"), std::string("1"), std::string("\"x\""), deep, deep_object}) {
            const auto code = server.raw(method, route, payload, {{"Authorization", "Bearer " + token}}).status;
            if (code >= 500) problems.push_back(method + " " + route + " " + payload.substr(0, 12) + ": " + std::to_string(code));
        }
    }
    try {
        // It may also close the connection without waiting for the rest.
        const auto code = server.raw("POST", BASE, std::string(17 * 1024 * 1024, ' ')).status;
        EXPECT(code == 413, "a body has a limit", code);
    } catch (const Unreachable&) {
    }

    // Query strings and path segments.
    for (const auto& route : {std::string("/api/v1/view/nodes?limit=-1"), std::string("/api/v1/view/nodes?offset=99999999999999999999"), std::string("/api/v1/view/edges/99999999999"),
                              std::string("/api/v1/view/places?kind=%00"), std::string("/api/v1/news?limit=x"), std::string("/api/v1/view/event-queue?view=x"),
                              std::string("/api/v1/fabric/state?since=x"), std::string("/api/v1/fabric/audit?limit=-1"), app + "/events?since=-1",
                              std::string("/assets/../../../../etc/passwd"), std::string("/assets/%2e%2e/%2e%2e/etc/passwd"), std::string("/media/../CMakeLists.txt")}) {
        const auto code = server.call("GET", route, none, token).status;
        if (code >= 500 || ((route.starts_with("/assets") || route.starts_with("/media")) && code == 200)) problems.push_back("GET " + route + ": " + std::to_string(code));
    }

    protections(server, token);
    std::string list;
    for (std::size_t i = 0; i < problems.size() && i < 60; ++i) list += "\n    " + problems[i];
    EXPECT(problems.empty(), list, std::to_string(problems.size()) + " in all");
    EXPECT(server.process.running(), "the server is still running");
    EXPECT(server.call("GET", "/health").status == 200);
    std::cout << "robustness ok\n";
}
