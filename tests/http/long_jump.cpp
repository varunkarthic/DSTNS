// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// A long jump through the day keeps the server answering while it is worked out, and lands Restricted: at a quarter
// speed, climbing back to what was asked for.
#include "harness.hpp"

#include <thread>

using namespace check;

int main() {
    const json RUN = {{"seed", "10775"}, {"playback_duration_seconds", 600}, {"map", {{"osm_file", "data/fixtures/real_network.osm.xml"}}}};
    TempDir tmp("dstns-long-jump-");
    Server server(tmp.path);
    const auto status = [&] { return server.op("GET", "/api/v1/playback/status", none, 10).data(); };
    const auto backpressure = [&] { return server.op("GET", "/api/v1/system/backpressure", none, 10).body; };
    server.op("POST", "/api/v1/playback/start", RUN, 30);
    for (const double end = now() + 60; now() < end && status().at("lifecycle") != "RUNNING";) delay(0.1);
    EXPECT(status().at("lifecycle") == "RUNNING");
    EXPECT(server.op("PUT", "/api/v1/control/tick-rate", json{{"tick_rate", 10.0}}).status == 200);

    // The jump, on a thread of its own, as a person's click would be.
    Reply landed;
    std::thread jump([&] { landed = server.op("POST", "/api/v1/playback/seek", json{{"target_time", "16:00:00"}, {"play", true}}, 120); });
    double slowest = 0;
    bool seen_seeking = false, seen_restricted = false;
    std::uint32_t first = 0, last = 0;
    for (const double end = now() + 100; now() < end;) {
        const double asked = now();
        const auto s = status();
        slowest = std::max(slowest, now() - asked);
        if (s.at("lifecycle") == "SEEKING") {
            seen_seeking = true;
            const auto at = s.at("simulated_seconds").get<std::uint32_t>();
            if (!first) first = at;
            last = at;
            seen_restricted = seen_restricted || backpressure().at("restriction") == "jump";
        } else if (seen_seeking) break;
        delay(0.05);
    }
    jump.join();
    EXPECT(landed.status == 200, landed.body);
    EXPECT(seen_seeking, "the jump is seen as it is worked out");
    EXPECT(last > first, "and its clock moves while it is", first, last);
    EXPECT(slowest < 1.5, "the server answers within a moment throughout", slowest);
    EXPECT(seen_restricted, "it is Restricted while it is worked out");

    // It lands at a quarter speed, Restricted, and climbs back to 10x.
    const auto after = backpressure();
    EXPECT(after.at("state") == "RESTRICTED" && after.at("restriction") == "jump" && after.at("motion_locked") == true, after);
    EXPECT(after.at("applied_tick_rate").get<double>() < 10.0 && after.at("requested_tick_rate") == 10.0, after);
    json back;
    for (const double end = now() + 30; now() < end; delay(0.25)) {
        back = backpressure();
        if (back.at("applied_tick_rate") == 10.0) break;
    }
    EXPECT(back.at("applied_tick_rate") == 10.0 && back.at("state") == "NORMAL" && back.at("restriction") == "", back);
    std::cout << "Long jump: the server answers throughout, and it lands Restricted and climbs back\n";
}
