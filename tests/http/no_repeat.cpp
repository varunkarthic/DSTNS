// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// A session's new worlds: Regenerate goes to a city the session has not shown while the policy has one, and comes
// back to one only once there is no other. Three cities, each served from the Berlin fixture, and no network.
#include "harness.hpp"

#include <set>

using namespace check;

int main() {
    TempDir tmp("dstns-no-repeat-");
    const auto maps = tmp / "maps";
    fs::create_directories(maps);
    const std::vector<std::string> cities{"berlin", "munich", "hamburg"};
    for (const auto& city : cities) fs::copy_file(root() / "data/fixtures/real_network.osm.xml", maps / (city + "_x5000.osm.xml"));
    Server server(tmp.path, {"--maps", maps.string(), "--map-cache", "keep"}, {{"DSTNS_FETCHER", "/usr/bin/false"}, {"DSTNS_DYNAMIC_FASTBOOT", "0"}});
    const auto city_now = [&] { return server.op("GET", "/api/v1/view/topology").data().at("location").at("city").get<std::string>(); };
    const auto ready = [&](const json& before) {
        until([&]() -> std::optional<bool> {
            const auto now = server.op("GET", "/api/v1/playback/status").data();
            if (now.at("run_id") != before && (now.at("lifecycle") == "RUNNING" || now.at("lifecycle") == "PAUSED")) return true;
            return std::nullopt;
        }, 60, "the world");
    };
    const json start = {{"seed", "7"}, {"engine", "core-ng"}, {"map", {{"osm_file", "auto"}, {"cache_dir", maps.string()}}},
                        {"map_selection_version", "urban-geo-v2"}, {"map_selection", {{"mode", "cities"}, {"cities", cities}}}};
    const auto started = server.op("POST", "/api/v1/playback/start", start);
    EXPECT(started.status == 202, show(started));
    ready(nullptr);
    std::vector<std::string> shown{city_now()};
    for (int i = 0; i < 6; ++i) {
        const auto before = server.op("GET", "/api/v1/playback/status").data().at("run_id");
        const auto asked = server.op("POST", "/api/v1/world/regenerate", json::object());
        EXPECT(asked.status == 202 || asked.status == 200, show(asked));
        ready(before);
        shown.push_back(city_now());
    }
    std::string order;
    for (const auto& c : shown) order += c + " ";
    // Each round of three shows every city once; a new round never starts where the last one ended.
    for (std::size_t round = 0; round + 3 <= shown.size(); round += 3)
        EXPECT(std::set<std::string>(shown.begin() + round, shown.begin() + round + 3).size() == 3, "a city repeated within a round: " + order);
    for (std::size_t i = 1; i < shown.size(); ++i) EXPECT(shown[i] != shown[i - 1], "the same city twice in a row: " + order);
    std::cout << "No repeat: " << order << "\n";
}
