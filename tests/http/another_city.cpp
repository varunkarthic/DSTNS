// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Trying again after a failed map download goes somewhere else, and uses no network.
#include "harness.hpp"

#include <regex>

using namespace check;

int main() {
    TempDir tmp("dstns-another-city-");
    Server server(tmp.path, {"--maps", (tmp / "maps").string(), "--map-cache", "keep"}, {{"DSTNS_FETCHER", "/usr/bin/false"}});
    const auto failed_city = [&] {
        return until([&]() -> std::optional<std::string> {
            const auto status = server.op("GET", "/api/v1/playback/status").data();
            std::smatch city;
            const auto error = status.at("preparation_error").get<std::string>();
            if (status.at("lifecycle") == "IDLE" && std::regex_search(error, city, std::regex(R"(failed for (.+?) \()"))) return city[1].str();
            return std::nullopt;
        }, 8, "the download to fail").value();
    };
    server.op("POST", "/api/v1/playback/start", json{{"seed", "42"}, {"map", {{"osm_file", "auto"}}}});
    auto city = failed_city();
    for (int i = 0; i < 8; ++i) {
        server.op("POST", "/api/v1/world/regenerate", json::object());
        // Each attempt must have begun before its result is read.
        const auto following = failed_city();
        EXPECT(following != city, "tried " + city + " again");
        city = following;
    }
    std::cout << "Another city: every retry after a failed download chose a different city\n";
}
