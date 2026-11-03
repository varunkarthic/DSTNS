// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// A world waits for an observer showing its start-up, and for nobody else.
#include "harness.hpp"

using namespace check;

int main() {
    const json RUN = {{"seed", "12345"}, {"playback_duration_seconds", 3600}, {"map", {{"osm_file", "tests/fixtures/roads.osm.xml"}}}};
    TempDir tmp("dstns-observer-hold-");
    Server server(tmp.path);
    const auto post = [&](const std::string& route, const json& data = json::object()) { return server.op("POST", route, data, 10).body; };
    const auto status = [&] { return server.op("GET", "/api/v1/playback/status", none, 10).data(); };
    const auto wait_until = [&](auto check, double seconds = 8, std::function<void()> keep = nullptr) {
        const double end = now() + seconds;
        while (now() < end) {
            if (keep) keep();
            auto value = status();
            if (check(value)) return value;
            delay(0.05);
        }
        fail("timed out at " + status().dump(), __FILE__, __LINE__);
    };
    const auto lifecycle = [](const char* wanted) { return [wanted](const json& s) { return s.at("lifecycle") == wanted; }; };
    const auto stopped = [](const json& s) { return s.at("lifecycle") == "IDLE" || s.at("lifecycle") == "STOPPED"; };
    const auto ping = [&] { post("/api/v1/system/observer", {{"waiting", true}}); };

    // Nobody watching: it just runs.
    post("/api/v1/playback/start", RUN);
    EXPECT(wait_until(lifecycle("RUNNING")).at("observer_hold") == false);

    // An observer arriving during a run changes nothing.
    ping();
    delay(0.2);
    EXPECT(status().at("lifecycle") == "RUNNING");
    post("/api/v1/system/observer", {{"waiting", false}});

    // Watching: it waits at its first second, and goes when the observer is ready.
    post("/api/v1/playback/reset");
    wait_until(stopped);
    ping();
    post("/api/v1/playback/start", RUN);
    const auto held = wait_until(lifecycle("PAUSED"), 8, ping);
    EXPECT(held.at("observer_hold") == true, held);
    const auto first = held.value("simulated_seconds", json());
    for (int i = 0; i < 10; ++i) {
        ping();
        delay(0.1);
    }
    const auto after = status();
    EXPECT(after.at("lifecycle") == "PAUSED" && after.value("simulated_seconds", json()) == first, after);
    post("/api/v1/system/observer", {{"waiting", false}});
    EXPECT(wait_until(lifecycle("RUNNING")).at("observer_hold") == false);

    // The observer goes away while it waits: the engine carries on by itself.
    post("/api/v1/playback/reset");
    wait_until(stopped);
    ping();
    post("/api/v1/playback/start", RUN);
    wait_until(lifecycle("PAUSED"), 8, ping);
    const double gone = now();
    wait_until(lifecycle("RUNNING"), 8);
    const double waited = now() - gone;
    EXPECT(waited > 2 && waited < 7, "resumed about when the lease ran out", waited);

    // Pausing during the wait is a real pause, and it is not undone by the observer leaving.
    post("/api/v1/playback/reset");
    wait_until(stopped);
    ping();
    post("/api/v1/playback/start", RUN);
    wait_until(lifecycle("PAUSED"), 8, ping);
    EXPECT(post("/api/v1/playback/pause").at("changed") == true);
    post("/api/v1/system/observer", {{"waiting", false}});
    delay(0.3);
    EXPECT(status().at("lifecycle") == "PAUSED");
    post("/api/v1/playback/play");
    wait_until(lifecycle("RUNNING"));
    std::cout << "Observer hold: headless runs, an observer holds and releases, leaving releases, a pause stays a pause\n";
}
