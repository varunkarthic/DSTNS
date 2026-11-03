// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Request validation and cross-site protection against a real server and a running world.
#include "harness.hpp"

using namespace check;

int main() {
    TempDir tmp("dstns-hardening-");
    Server server(tmp.path, {"--maps", tmp.str(), "--map-cache", "keep"});
    server.op("POST", "/api/v1/playback/start", json{{"seed", "723921"}, {"map", {{"osm_file", (root() / "tests/fixtures/roads.osm.xml").string()}}}});
    until([&] { return server.call("GET", "/api/v1/playback/status").data().at("lifecycle") == "RUNNING"; }, 15, "the run");
    const auto call = [&](const std::string& route, const std::string& method = "GET", std::optional<json> data = none, Headers headers = {}) {
        return server.call(method, route, data, "", headers, 5);
    };
    const auto own = "http://127.0.0.1:" + std::to_string(server.port);

    // A state change from another site is refused.
    auto reply = call("/api/v1/playback/pause", "POST", json::object(), {{"Origin", "https://attacker.example"}});
    EXPECT(reply.status == 403 && reply.code() == "CROSS_ORIGIN_FORBIDDEN", reply);
    EXPECT(call("/api/v1/system/terminate", "POST", json::object(), {{"Origin", "null"}}).status == 403);
    EXPECT(server.process.running(), "the server survived a forged terminate");

    // The same origin, and no origin, pass.
    EXPECT(call("/api/v1/playback/pause", "POST", json::object(), {{"Origin", own}}).status == 200);
    EXPECT(call("/api/v1/playback/play", "POST", json::object()).status == 200);

    // After DNS rebinding the attacker's hostname is in both Origin and Host, so the same-origin check alone passes;
    // the Host check must refuse it.
    for (const auto& [method, route] : std::vector<std::pair<std::string, std::string>>{{"GET", "/api/v1/playback/status"}, {"POST", "/api/v1/playback/pause"}}) {
        reply = call(route, method, method == "POST" ? std::optional<json>(json::object()) : none,
                     {{"Host", "rebind.attacker.example:8090"}, {"Origin", "http://rebind.attacker.example:8090"}});
        EXPECT(reply.status == 421 && reply.code() == "HOST_NOT_ALLOWED", route, reply);
    }

    // Loopback names and IP literals are accepted.
    const auto port = std::to_string(server.port);
    for (const auto& host : {"127.0.0.1:" + port, "localhost:" + port, "app.localhost:" + port, "[::1]:" + port, std::string("10.1.2.3:8090")}) {
        EXPECT(call("/api/v1/playback/status", "GET", none, {{"Host", host}}).status == 200, host);
    }

    // Another site's page gets a response (a GET is harmless) but not the header that would let a browser show it.
    reply = call("/api/v1/playback/status", "GET", none, {{"Origin", "https://elsewhere.example"}});
    EXPECT(reply.status == 200 && reply.header("Access-Control-Allow-Origin").empty() && reply.header("Vary") == "Origin", reply);
    EXPECT(call("/api/v1/playback/status", "GET", none, {{"Origin", own}}).header("Access-Control-Allow-Origin") == own);

    // Terminating cannot be done with a GET.
    for (const char* route : {"/terminate", "/api/v1/system/terminate"}) EXPECT(call(route).status == 404, route);
    EXPECT(server.process.running());

    // Identifiers do not wrap: 2^32 would truncate to edge 0 under a narrowing cast.
    reply = call("/api/v1/control/edges/4294967296/override", "POST", json{{"closed", true}});
    EXPECT(reply.status == 400, reply);
    EXPECT(call("/api/v1/view/nodes/99999999999999999999").status == 400);

    // Out of range, negative or unbounded numbers are refused.
    EXPECT(call("/api/v1/playback/seek", "POST", json{{"target_time", 999999}}).status == 400);
    EXPECT(call("/api/v1/news?since_news_id=-1").status == 400);
    EXPECT(call("/api/v1/view/logs/api?limit=-5").status == 400);
    EXPECT(call("/api/v1/control/events/weather", "POST", json{{"epicenter_node", 0}, {"duration_virtual_minutes", -10}}).status == 400);
    EXPECT(call("/api/v1/control/events/weather", "POST", json{{"epicenter_node", 0}, {"duration_virtual_minutes", 1e12}}).status == 400);
    EXPECT(call("/api/v1/control/events/surge", "POST", json{{"node_id", 0}, {"factor", -3}}).status == 400);
    // -1 read as unsigned is 4294967295: everything would be undone.
    for (int count : {-1, 0}) {
        EXPECT(call("/api/v1/control/undo", "POST", json{{"count", count}}).status == 400, count);
        EXPECT(call("/api/v1/control/redo", "POST", json{{"count", count}}).status == 400, count);
    }
    EXPECT(call("/api/v1/system/sumo-simulate", "POST", json{{"begin_s", 3600}, {"end_s", 60}}).status == 400);
    std::cout << "hardening ok\n";
}
