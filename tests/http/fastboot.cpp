// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Fast Boot: a city kept compressed in advance is unpacked and used, with no download.
#include "harness.hpp"
#include "support.hpp"

#include <set>

using namespace check;

int main() {
    const auto fixture = root() / "data/fixtures/real_network.osm.xml";
    const auto listed = json::parse(run({server_binary(), "--list-cities", "5000"}).output);
    EXPECT(listed.size() >= 100);
    std::set<std::string> keys;
    for (const auto& city : listed) {
        EXPECT(city.contains("city") && city.contains("country") && city.contains("key") && city.contains("bbox"), city);
        keys.insert(city.at("key"));
    }
    EXPECT(keys.contains("berlin_x5000") && keys.contains("london_x5000"));
    // Seeds that choose Berlin, whose centre the fixture covers.
    std::vector<int> seeds;
    for (int seed = 1; seed < 4000 && seeds.size() < 3; ++seed) {
        if (json::parse(run({server_binary(), "--city-of-seed", std::to_string(seed)}).output).at("key") == "berlin_x5000") seeds.push_back(seed);
    }
    EXPECT(!seeds.empty(), "a seed that chooses Berlin");

    TempDir tmp;
    const auto fast = tmp / "fastboot";
    const auto maps = tmp / "maps";
    fs::create_directories(fast);
    const auto original = read(fixture);
    write(fast / "berlin_x5000.osm.xml.gz", dstns::fabric::gzip(original, 6));
    // A damaged one is not trusted, and nothing half-written is left behind.
    write(fast / "london_x5000.osm.xml.gz", "not gzip at all");
    Server s(tmp.path, {}, {{"DSTNS_FASTBOOT_DIR", fast.string()}});
    std::optional<std::pair<int, double>> ran;
    for (int seed : seeds) {
        const double began = now();
        const auto started = s.op("POST", "/api/v1/playback/start",
                                  json{{"seed", std::to_string(seed)}, {"playback_duration_seconds", 600}, {"map", {{"osm_file", "auto"}, {"cache_dir", maps.string()}}}});
        EXPECT(started.status == 202, started);
        json status;
        while (now() - began < 30) {
            status = s.call("GET", "/api/v1/fabric/engine/status").data();
            if (status.at("lifecycle") == "RUNNING" || (status.at("lifecycle") == "IDLE" && !status.value("preparation_error", "").empty())) break;
            delay(0.1);
        }
        if (status.at("lifecycle") == "RUNNING") {
            ran = {seed, now() - began};
            break;
        }
        // The district this seed grows may fall outside the small fixture: try the next.
        s.op("POST", "/api/v1/fabric/engine/stop", json::object());
    }
    EXPECT(ran, "a Berlin seed ran from the packed city");
    EXPECT(read(maps / "berlin_x5000.osm.xml") == original, "unpacked whole, byte for byte");
    for (const auto& entry : fs::directory_iterator(maps)) EXPECT(entry.path().extension() != ".unpacking", "nothing half-written left", entry.path().string());
    EXPECT(s.call("GET", "/api/v1/view/topology").data().at("location").at("city") == "Berlin");
    std::cout << "seed " << ran->first << " ran in " << ran->second << " s with no download\nfastboot ok\n";
}
