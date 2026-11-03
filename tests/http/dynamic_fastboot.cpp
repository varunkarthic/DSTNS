// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Dynamic Fastboot: while a world runs, the next city is fetched in the background and named in next-world.json. A
// restart keeps it through the cache sweep, and the next world takes it, with no download while anyone waits. And the
// server says how long a world being prepared will take.
#include "harness.hpp"
#include "support.hpp"

#include <atomic>
#include <memory>

using namespace check;

int main() {
    const auto fixture = read(root() / "data/fixtures/real_network.osm.xml");
    // Seeds that choose Berlin, whose centre the fixture covers.
    std::vector<std::string> berlin;
    for (int seed = 1; seed < 4000 && berlin.size() < 3; ++seed) {
        if (json::parse(run({server_binary(), "--city-of-seed", std::to_string(seed)}).output).at("key") == "berlin_x5000") berlin.push_back(std::to_string(seed));
    }
    EXPECT(!berlin.empty());

    // Overpass, standing in: it serves the fixture for whatever is asked, and counts.
    std::atomic<int> asked = 0;
    Upstream overpass;
    overpass.http.Post(".*", [&](const httplib::Request&, httplib::Response& res) {
        ++asked;
        res.set_content(fixture, "application/octet-stream");
    });
    overpass.start();

    TempDir tmp;
    const auto maps = tmp / "maps";
    const auto fast = tmp / "fastboot";
    fs::create_directories(fast);
    write(fast / "berlin_x5000.osm.xml.gz", dstns::fabric::gzip(fixture, 6));
    const Env environment = {{"DSTNS_FASTBOOT_DIR", fast.string()}, {"DSTNS_OVERPASS_ENDPOINTS", overpass.url() + "/api/interpreter"}};
    const auto start_berlin = [&](Server& server) {
        for (const auto& seed : berlin) {
            const auto started = server.op("POST", "/api/v1/playback/start", json{{"seed", seed}, {"playback_duration_seconds", 600}, {"map", {{"osm_file", "auto"}, {"cache_dir", maps.string()}}}});
            EXPECT(started.status == 202, started);
            // While it is prepared, the server says how long that will take.
            const auto preparing = server.call("GET", "/api/v1/playback/status").data();
            if (preparing.at("lifecycle") == "PREPARING") EXPECT(preparing.at("eta_s").is_number() && preparing.at("eta_s") > 0 && preparing.at("eta_confident").is_boolean(), preparing);
            json status;
            for (const double end = now() + 30; now() < end; delay(0.1)) {
                status = server.call("GET", "/api/v1/playback/status").data();
                if (status.at("lifecycle") == "RUNNING" || (status.at("lifecycle") == "IDLE" && !status.value("preparation_error", "").empty())) break;
            }
            if (status.at("lifecycle") == "RUNNING") {
                EXPECT(status.at("eta_s").is_null(), "nothing is being prepared", status);
                return true;
            }
            server.op("POST", "/api/v1/fabric/engine/stop", json::object());
        }
        return false;
    };

    std::string next_seed, next_key;
    {
        Server server(tmp.path, {"--maps", maps.string(), "--map-cache", "keep"}, environment);
        EXPECT(start_berlin(server), "a Berlin seed ran from its Fast Boot pack");
        // The next world, somewhere else, fetched in the background.
        const auto next = *until([&]() -> std::optional<json> {
            auto status = server.call("GET", "/api/v1/world/status").data().at("next");
            if (status.at("state") == "ready") return status;
            return std::nullopt;
        }, 20, "the next world's city");
        EXPECT(next.at("enabled") == true && next.at("city") != "Berlin", next);
        const auto pointer = json::parse(read(maps / "next-world.json"));
        next_seed = pointer.at("seed");
        next_key = pointer.at("key");
        EXPECT(pointer.at("state") == "ready" && next.at("seed") == next_seed, pointer);
        EXPECT(fs::exists(maps / (next_key + ".osm.xml")), "its city is on disk");
        EXPECT(asked >= 1, "from Overpass");
        // The server says it does this.
        EXPECT(server.call("GET", "/api/v1/system/features").data().at("presentation").at("dynamic_fastboot") == true);
    }

    // A restart that sweeps the cache keeps the next world's city.
    Server server(tmp.path, {"--maps", maps.string(), "--map-cache", "clear"}, environment);
    EXPECT(fs::exists(maps / (next_key + ".osm.xml")), "the sweep kept the next world's city");
    EXPECT(!fs::exists(maps / "berlin_x5000.osm.xml"), "and cleared the rest");
    const int before = asked;
    EXPECT(start_berlin(server));
    // Another world, prepared already, stands; the next new world takes it, and nothing is downloaded for it.
    delay(0.5);
    EXPECT(server.call("GET", "/api/v1/world/status").data().at("next").at("seed") == next_seed);
    // Asked for, the new world is prepared at once, while this one carries on; it goes in only when confirmed.
    const auto run_before = server.call("GET", "/api/v1/playback/status").body.at("run_id");
    const auto staged = server.op("POST", "/api/v1/world/regenerate", json{{"stage", true}});
    EXPECT(staged.status == 202 && staged.data().at("seed") == next_seed, staged);
    until([&] { return server.call("GET", "/api/v1/world/status").data().at("state") == "staged"; }, 20, "the world to be prepared");
    EXPECT(server.call("GET", "/api/v1/playback/status").data().at("lifecycle") == "RUNNING", "the current world was not paused");
    EXPECT(server.call("GET", "/api/v1/playback/status").body.at("run_id") == run_before, "nor replaced");
    EXPECT(asked == before, "no download for a city already on disk", asked.load(), before);
    const auto committed = server.op("POST", "/api/v1/world/regenerate/commit", json::object());
    EXPECT(committed.status == 202 && committed.data().at("state") == "ready", "put in at once", committed);
    const auto after = server.call("GET", "/api/v1/playback/status").body;
    EXPECT(after.at("run_id") != run_before && after.at("seed") == next_seed && after.at("data").at("lifecycle") == "PAUSED", after);
    // Changing one's mind forgets it, and leaves the world as it was.
    EXPECT(server.op("POST", "/api/v1/world/regenerate", json{{"stage", true}}).status == 202);
    const auto discarded = server.op("POST", "/api/v1/world/regenerate/discard", json::object());
    EXPECT(discarded.status == 200 && discarded.data().at("state") == "idle", discarded);
    EXPECT(server.call("GET", "/api/v1/playback/status").body.at("run_id") == after.at("run_id"));
    EXPECT(server.op("POST", "/api/v1/world/regenerate/commit", json::object()).status == 409, "nothing left to confirm");

    // Turned off, it does none of this.
    TempDir off;
    Server plain(off.path, {"--maps", (off / "maps").string(), "--map-cache", "keep"}, {{"DSTNS_DYNAMIC_FASTBOOT", "0"}});
    EXPECT(plain.call("GET", "/api/v1/world/status").data().at("next").at("enabled") == false);
    EXPECT(plain.call("GET", "/api/v1/system/features").data().at("presentation").at("dynamic_fastboot") == false);
    std::cout << "dynamic fastboot ok: next city fetched, kept through a sweep, taken by the next world; ETA reported\n";
}
