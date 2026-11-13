// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The engine switch: a start names "core-legacy" (the default) or "core-ng". Both prepare the same world, with the
// same hashes, and say which engine runs it. An engine the server does not have is refused before anything starts.
#include "harness.hpp"

using namespace check;

namespace {
json run_on(const std::string& engine, const std::string& seed, const json& extra = json::object(), bool regenerate = false) {
    TempDir tmp;
    const auto maps = tmp / "maps";
    fs::create_directories(maps);
    fs::copy_file(root() / "data/fixtures/real_network.osm.xml", maps / "berlin_x5000.osm.xml");
    Server server(tmp.path, {"--maps", maps.string(), "--map-cache", "keep"}, {{"DSTNS_FETCHER", "/usr/bin/false"}});
    json start = {{"seed", seed}, {"map", {{"osm_file", "auto"}, {"cache_dir", maps.string()}}}};
    if (!engine.empty()) start["engine"] = engine;
    start.update(extra);
    const auto started = server.op("POST", "/api/v1/playback/start", start);
    EXPECT(started.status == 202, show(started));
    // core-ng is beta: its start waits for acknowledgment (tests/http/engine_gate.cpp), which the observer gives.
    if (started.data().value("state", "") == "approval_required") {
        const auto accepted = server.call("POST", "/api/v1/engine/approval", json{{"approval_id", started.data().at("approval_id")}, {"decision", "accept"}}, "", {{"X-DSTNS-Host", "1"}});
        EXPECT(accepted.status == 200 && !accepted.data().contains("start_error"), show(accepted));
    }
    const auto status = until([&]() -> std::optional<json> {
        const auto data = server.op("GET", "/api/v1/playback/status").data();
        if (data.at("lifecycle") == "RUNNING" || data.at("lifecycle") == "PAUSED") return data;
        return std::nullopt;
    }, 60, "the world to be ready").value();
    auto manifest = server.op("GET", "/api/v1/view/manifest").data();
    // The manifest's summary says what the topology says, so the launcher need not read the whole topology.
    {
        const auto topology = server.op("GET", "/api/v1/view/topology").data();
        const auto& network = manifest.at("network");
        EXPECT(network.at("nodes") == topology.at("nodes").size() && network.at("edges") == topology.at("edges").size() && network.at("features") == topology.at("features").size(), network);
        EXPECT(network.at("location").at("city") == topology.at("location").at("city") && network.at("source") == topology.at("source"), network);
    }
    json regenerated;
    if (regenerate) {
        // A new world keeps the engine and the policy, and so stays where the policy allows.
        const auto before = status.at("run_id");
        const auto asked = server.op("POST", "/api/v1/world/regenerate", json::object());
        EXPECT(asked.status == 202 || asked.status == 200, show(asked));
        until([&]() -> std::optional<bool> {
            const auto now = server.op("GET", "/api/v1/playback/status").data();
            if (now.at("run_id") != before && (now.at("lifecycle") == "RUNNING" || now.at("lifecycle") == "PAUSED")) return true;
            return std::nullopt;
        }, 60, "the new world");
        regenerated = {{"manifest", server.op("GET", "/api/v1/view/manifest").data()},
                       {"city", server.op("GET", "/api/v1/view/topology").data().at("location").at("city")}};
    }
    return {{"regenerated", regenerated}, {"city", server.op("GET", "/api/v1/view/topology").data().at("location").at("city")},{"status_engine", status.at("engine")}, {"manifest", manifest}, {"status", status},
            {"engines", server.op("GET", "/api/v1/system/info").body.at("engines")}};
}
} // namespace

int main() {
    // A seed that chooses Berlin, whose centre the fixture covers.
    std::string seed;
    for (int candidate = 1; candidate < 4000 && seed.empty(); ++candidate)
        if (json::parse(run({server_binary(), "--city-of-seed", std::to_string(candidate)}).output).at("key") == "berlin_x5000")
            seed = std::to_string(candidate);
    EXPECT(!seed.empty());

    const auto legacy = run_on("", seed);
    const auto ng = run_on("core-ng", seed);
    EXPECT(legacy.at("status_engine") == "core-legacy", legacy.dump());
    EXPECT(legacy.at("manifest").at("engine") == "core-legacy", legacy.dump());
    EXPECT(ng.at("status_engine") == "core-ng", ng.dump());
    EXPECT(ng.at("manifest").at("engine") == "core-ng", ng.dump());
    EXPECT(ng.at("engines") == json::array({"core-legacy", "core-ng"}), ng.dump());
    for (const auto* hash : {"map_hash", "graph_hash", "event_hash", "scenario_hash"})
        EXPECT(legacy.at("manifest").at(hash) == ng.at("manifest").at(hash), std::string(hash) + " differs between engines");

    // urban-geo-v1 on core-ng: Berlin fixed, any seed. The manifest names the policy and its fingerprint.
    const json berlin = {{"map_selection_version", "urban-geo-v1"}, {"map_selection", {{"mode", "fixed_city"}, {"cities", {"berlin"}}}}};
    const auto fixed = run_on("core-ng", "7", berlin, true);
    EXPECT(fixed.at("city") == "Berlin" && fixed.at("regenerated").at("city") == "Berlin", fixed.dump().substr(0, 400));
    EXPECT(fixed.at("regenerated").at("manifest").at("map_selection") == fixed.at("manifest").at("map_selection"), "the new world keeps the policy");
    EXPECT(fixed.at("regenerated").at("manifest").at("engine") == "core-ng", "the new world keeps the engine");
    const auto selection = fixed.at("manifest").at("map_selection");
    EXPECT(selection.at("policy") == "urban-geo-v1" && selection.at("mode") == "fixed_city" && selection.at("cities") == json::array({"berlin"}), selection.dump());
    EXPECT(selection.at("fingerprint").get<std::string>().starts_with("sha256:"), selection.dump());
    EXPECT(fixed.at("status").at("map_selection_version") == "urban-geo-v1", fixed.dump());
    EXPECT(legacy.at("manifest").at("map_selection").at("policy") == "urban-crfg-v3", legacy.dump());

    // Refused at once, with nothing started.
    TempDir tmp;
    Server server(tmp.path);
    const json fixture = {{"osm_file", "tests/fixtures/roads.osm.xml"}};
    for (const auto& [why, body] : std::vector<std::pair<std::string, json>>{
             {"an unknown engine", {{"seed", "1"}, {"engine", "core-next"}, {"map", fixture}}},
             {"a policy core-legacy does not have", [&] { json b{{"seed", "1"}, {"map", fixture}}; b.update(berlin); return b; }()},
             {"an unknown country", {{"seed", "1"}, {"engine", "core-ng"}, {"map", fixture}, {"map_selection_version", "urban-geo-v1"},
                                     {"map_selection", {{"mode", "countries"}, {"countries", {"XX"}}}}}},
             {"a malformed list", {{"seed", "1"}, {"engine", "core-ng"}, {"map", fixture}, {"map_selection_version", "urban-geo-v1"},
                                   {"map_selection", {{"mode", "countries"}, {"countries", "IN"}}}}}}) {
        const auto refused = server.op("POST", "/api/v1/playback/start", body);
        EXPECT(refused.status == 400, why + ": " + show(refused));
        EXPECT(server.op("GET", "/api/v1/playback/status").data().at("lifecycle") == "IDLE", why);
    }
    std::cout << "Engine switch: core-legacy and core-ng give identical hashes for seed " << seed << ", and a fixed city on urban-geo-v1 runs on core-ng, and unknown engines and policies are refused\n";
}
