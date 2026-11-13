// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The engine switch: a start names "core-legacy" (the default) or "core-ng". Both prepare the same world, with the
// same hashes, and say which engine runs it. An engine the server does not have is refused before anything starts.
#include "harness.hpp"

using namespace check;

namespace {
json run_on(const std::string& engine, const std::string& seed) {
    TempDir tmp;
    const auto maps = tmp / "maps";
    fs::create_directories(maps);
    fs::copy_file(root() / "data/fixtures/real_network.osm.xml", maps / "berlin_x5000.osm.xml");
    Server server(tmp.path, {"--maps", maps.string(), "--map-cache", "keep"}, {{"DSTNS_FETCHER", "/usr/bin/false"}});
    json start = {{"seed", seed}, {"map", {{"osm_file", "auto"}, {"cache_dir", maps.string()}}}};
    if (!engine.empty()) start["engine"] = engine;
    const auto started = server.op("POST", "/api/v1/playback/start", start);
    EXPECT(started.status == 202, show(started));
    const auto status = until([&]() -> std::optional<json> {
        const auto data = server.op("GET", "/api/v1/playback/status").data();
        if (data.at("lifecycle") == "RUNNING" || data.at("lifecycle") == "PAUSED") return data;
        return std::nullopt;
    }, 60, "the world to be ready").value();
    const auto manifest = server.op("GET", "/api/v1/view/manifest").data();
    return {{"status_engine", status.at("engine")}, {"manifest", manifest},
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

    // Refused at once, with nothing started.
    TempDir tmp;
    Server server(tmp.path);
    const auto refused = server.op("POST", "/api/v1/playback/start",
                                   json{{"seed", "1"}, {"engine", "core-next"}, {"map", {{"osm_file", "tests/fixtures/roads.osm.xml"}}}});
    EXPECT(refused.status == 400, show(refused));
    EXPECT(server.op("GET", "/api/v1/playback/status").data().at("lifecycle") == "IDLE");
    std::cout << "Engine switch: core-legacy and core-ng give identical hashes for seed " << seed << ", and an unknown engine is refused\n";
}
