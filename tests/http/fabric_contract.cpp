// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The HTTP contract Fabric must preserve, checked against a recorded baseline.
//
// fabric_contract.golden.json was recorded from the server as it stood before the API moved under Fabric. Each route is
// called with the same request and compared: the status must match, every recorded response key must still exist with
// the same type, and recorded headers must match. New routes and new keys are allowed, which is the compatibility
// promise in docs/api/versioning.md.
//
//     fabric_contract            compare
//     fabric_contract --record   rewrite the baseline (only for an intentional, documented contract change)
#include "harness.hpp"

#include <iomanip>

using namespace check;

namespace {

const fs::path GOLDEN = root() / "tests/http/fabric_contract.golden.json";
const std::vector<std::string> HEADERS = {"Cache-Control", "Vary", "Access-Control-Allow-Origin", "Deprecation"};
const json RUN = {{"seed", "12345"}, {"playback_duration_seconds", 3600}, {"map", {{"osm_file", "tests/fixtures/roads.osm.xml"}}}};

// Reads that must behave identically before a run and during one.
const std::vector<std::string> READS = {
    "/health", "/api/v1", "/api/v1/system/health", "/api/v1/system/info", "/api/v1/system/status", "/api/v1/system/endpoints",
    "/api/v1/system/map-status", "/api/v1/system/source", "/api/v1/system/backpressure", "/api/v1/system/ui-config",
    "/api/v1/system/observer", "/api/v1/system/narrator", "/api/v1/playback/status", "/api/v1/world/status", "/api/v1/control/history",
    "/api/v1/view/run", "/api/v1/view/config", "/api/v1/view/manifest", "/api/v1/view/topology", "/api/v1/topology", "/api/v1/view/network",
    "/api/v1/view/map/full", "/api/v1/view/snapshot", "/api/v1/view/global", "/api/v1/view/world", "/api/v1/view/all",
    "/api/v1/view/global.json", "/api/v1/view/nodes", "/api/v1/view/nodes/0", "/api/v1/view/nodes/999999", "/api/v1/view/edges",
    "/api/v1/view/edges/0", "/api/v1/view/places", "/api/v1/places", "/api/v1/view/place-kinds", "/api/v1/view/stops",
    "/api/v1/view/traffic", "/api/v1/view/weather", "/api/v1/view/buildings", "/api/v1/view/bus-stops", "/api/v1/view/signals",
    "/api/v1/view/events", "/api/v1/view/metrics", "/api/v1/view/incidents", "/api/v1/view/congestion", "/api/v1/view/event-queue",
    "/api/v1/view/event-queue?view=history", "/api/v1/view/event-queue?view=bad", "/api/v1/view/nodes?limit=0", "/api/v1/news",
    "/api/v1/news?since_news_id=-1", "/api/v1/view/logs/system", "/api/v1/view/logs/events", "/api/v1/view/logs/api",
    "/api/v1/view/stream", "/api/v1/news/stream", "/", "/index.html", "/no/such/route"};

struct Write {
    std::string method, route;
    std::optional<json> data; // a string is sent as it is, for a body that is not JSON
    Headers headers;
};

// Writes, in order, against a running world. Each carries the body and headers it sends, so refusals are part of the
// contract as much as successes.
const std::vector<Write> WRITES = {
    {"POST", "/api/v1/playback/start", RUN, {}},
    {"POST", "/api/v1/playback/prepare", RUN, {{"X-DSTNS-Operator", "wrong"}}},
    {"POST", "/api/v1/playback/pause", json::object(), {}},
    {"POST", "/api/v1/playback/play", json::object(), {{"Origin", "https://evil.example"}}},
    {"POST", "/api/v1/playback/play", json::object(), {{"Origin", "null"}}},
    {"GET", "/health", none, {{"Host", "evil.example"}}},
    {"POST", "/api/v1/playback/play", json::object(), {}},
    {"POST", "/api/v1/playback/pause", json::object(), {}},
    {"POST", "/api/v1/playback/seek", json{{"target_time", 60}}, {}},
    {"POST", "/api/v1/playback/seek", json{{"target_time", 90000}}, {}},
    {"POST", "/api/v1/playback/seek", json::object(), {}},
    {"POST", "/api/v1/playback/step", json{{"seconds", 1}}, {}},
    {"POST", "/api/v1/playback/step", json{{"seconds", 0}}, {}},
    {"PUT", "/api/v1/control/tick-rate", json{{"tick_rate", 1}}, {}},
    {"PUT", "/api/v1/control/tick-rate", json{{"tick_rate", "fast"}}, {}},
    {"POST", "/api/v1/control/day", json{{"day", 1}}, {}},
    {"PUT", "/api/v1/control/modules/news", json{{"enabled", true}}, {}},
    {"POST", "/api/v1/control/modules/news/enable", json::object(), {}},
    {"POST", "/api/v1/control/events/weather", json{{"epicenter_node", 0}}, {}},
    {"POST", "/api/v1/control/events/weather", json{{"epicenter_node", 0}, {"duration_virtual_minutes", 0}}, {}},
    {"POST", "/api/v1/control/events/traffic", json{{"target", {{"type", "edge"}, {"id", 0}}}, {"congestion_pressure", 0.5}}, {}},
    {"POST", "/api/v1/control/events/traffic", json{{"target", {{"type", "node"}, {"id", 0}}}, {"congestion_pressure", 0.5}}, {}},
    {"POST", "/api/v1/control/events/surge", json{{"node_id", 0}}, {}},
    {"PUT", "/api/v1/control/edges/0", json{{"speed_multiplier", 0.5}}, {}},
    {"POST", "/api/v1/control/edges/0/override", json{{"closed", false}}, {}},
    {"POST", "/api/v1/control/edges/4294967297/override", json::object(), {}},
    {"POST", "/api/v1/control/transit/route", json::object(), {}},
    {"POST", "/api/v1/control/undo", json{{"count", 1}}, {}},
    {"POST", "/api/v1/control/undo", json{{"count", -1}}, {}},
    {"POST", "/api/v1/control/redo", json{{"count", 1}}, {}},
    {"POST", "/api/v1/system/backpressure", json{{"virtual_lag_s", 0}, {"client_frame_s", 0.016}, {"since_poll_s", 0}}, {}},
    {"POST", "/api/v1/playback/pause", json("{not json"), {}},
    {"POST", "/api/v1/playback/reset", json::object(), {}},
    {"POST", "/stop", json::object(), {}},
    {"OPTIONS", "/api/v1/playback/pause", none, {{"Origin", "https://evil.example"}}},
    {"POST", "/terminate", json::object(), {}},
};

// A value's structure: object keys and types, arrays by their first item.
json shape(const json& value, int depth = 0) {
    if (value.is_object()) {
        if (depth >= 6) return "object";
        json out = json::object();
        for (const auto& [key, item] : value.items()) out[key] = shape(item, depth + 1);
        return out;
    }
    if (value.is_array()) return !value.empty() && depth < 6 ? json::array({shape(value[0], depth + 1)}) : json::array();
    if (value.is_boolean()) return "boolean";
    if (value.is_number()) return "number";
    if (value.is_string()) return "string";
    return "null";
}

// What the current shape lost against the recorded one. Additions are fine.
void mismatches(const json& recorded, const json& current, const std::string& where, std::vector<std::string>& out) {
    if (recorded == "null" || current == "null") return; // Optional until a value exists.
    if (recorded.is_object()) {
        if (!current.is_object()) {
            if (!recorded.empty()) out.push_back(where + ": was an object, now " + current.dump());
            return;
        }
        for (const auto& [key, value] : recorded.items()) {
            if (!current.contains(key)) out.push_back(where + "." + key + ": removed");
            else mismatches(value, current[key], where + "." + key, out);
        }
        return;
    }
    if (recorded.is_array()) {
        if (!current.is_array()) out.push_back(where + ": was an array, now " + current.dump());
        else if (!recorded.empty() && !current.empty()) mismatches(recorded[0], current[0], where + "[]", out);
        return;
    }
    if (recorded != current) out.push_back(where + ": was " + recorded.dump() + ", now " + current.dump());
}

json observe(int port, const std::string& method, const std::string& route, const std::optional<json>& data = none, const Headers& headers = {}) {
    Reply reply;
    try {
        reply = data && data->is_string() ? request(port, method, route, none, headers, 60, data->get<std::string>()) : request(port, method, route, data, headers, 60);
    } catch (const Unreachable& error) {
        fail(error.what(), __FILE__, __LINE__);
    }
    const auto type = reply.header("Content-Type");
    json body = "text";
    if (contains(type, "event-stream")) {
        // The two streams wrap JSON in one server-sent event.
        const auto at = reply.text.find("data: ");
        if (at != std::string::npos) body = json::parse(reply.text.substr(at + 6), nullptr, false);
    } else {
        body = json::parse(reply.text, nullptr, false);
    }
    if (body.is_discarded()) body = "text";
    json kept = json::object();
    for (const auto& name : HEADERS) {
        if (!reply.header(name).empty()) kept[name] = reply.header(name);
    }
    return {{"status", reply.status}, {"type", type}, {"body", body == "text" ? json("string") : shape(body)}, {"headers", kept}};
}

} // namespace

int main(int argc, char** argv) {
    const bool record = argc > 1 && std::string(argv[1]) == "--record";
    json observed = json::object();
    {
        TempDir tmp("dstns-contract-");
        Server server(tmp.path, {"--map-cache", "keep"});
        const int port = server.port;
        for (const auto& route : READS) observed["idle GET " + route] = observe(port, "GET", route);
        // The operator's credential, and its absence, are both contract.
        observed["POST /api/v1/playback/start without credential"] = observe(port, "POST", "/api/v1/playback/start", RUN);
        for (std::size_t index = 0; index < WRITES.size(); ++index) {
            auto [method, route, data, headers] = WRITES[index];
            if (route == "/api/v1/playback/start") headers = server.host;
            if (route == "/api/v1/playback/pause" && index == 2) {
                until([&] {
                    return request(port, "GET", "/api/v1/view/snapshot").status == 200 && request(port, "GET", "/api/v1/playback/status").data().at("lifecycle") == "RUNNING";
                }, 20, "the run to start");
                for (const auto& read_route : READS) observed["running GET " + read_route] = observe(port, "GET", read_route);
            }
            std::ostringstream name;
            name << std::setw(2) << std::setfill('0') << index << ' ' << method << ' ' << route << ' ' << (data ? data->dump() : "null");
            std::string names;
            for (const auto& [key, value] : headers) names += (names.empty() ? "" : ",") + key;
            if (!names.empty()) name << ' ' << names;
            observed[name.str()] = observe(port, method, route, data, headers);
        }
    }

    if (record) {
        write(GOLDEN, observed.dump(0) + "\n");
        std::cout << "Recorded " << observed.size() << " calls to " << GOLDEN.filename().string() << '\n';
        return 0;
    }
    const auto golden = json::parse(read(GOLDEN));
    std::vector<std::string> problems;
    for (const auto& [name, expected] : golden.items()) {
        if (!observed.contains(name)) {
            problems.push_back(name + ": not exercised");
            continue;
        }
        const auto& got = observed[name];
        if (got["status"] != expected["status"]) problems.push_back(name + ": status was " + expected["status"].dump() + ", now " + got["status"].dump());
        if (got["type"] != expected["type"]) problems.push_back(name + ": content type was " + expected["type"].dump() + ", now " + got["type"].dump());
        // Each value recorded is still sent; another beside it, such as Vary: Accept-Encoding, is an addition.
        for (const auto& [header, value] : expected["headers"].items()) {
            const auto now_sent = got["headers"].value(header, "");
            std::stringstream tokens(value.get<std::string>());
            for (std::string token; std::getline(tokens, token, ',');) {
                if (!contains(now_sent, trim(token))) problems.push_back(name + ": header " + header + " was " + value.dump() + ", now " + (now_sent.empty() ? "(none)" : now_sent));
            }
        }
        mismatches(expected["body"], got["body"], name, problems);
    }
    for (const auto& problem : problems) std::cout << problem << '\n';
    std::cout << golden.size() << " recorded calls, " << problems.size() << " differences\n";
    return problems.empty() ? 0 : 1;
}
