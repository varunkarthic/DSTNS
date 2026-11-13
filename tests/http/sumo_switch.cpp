// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The SUMO switch: DSTNS_SUMO=0 (the launcher's sumo.enabled, off by default) refuses both SUMO routes with 403
// SUMO_DISABLED and does not look for SUMO; without it, a server started by hand keeps SUMO.
#include "harness.hpp"

using namespace check;

int main() {
    for (const bool on : {false, true}) {
        TempDir tmp;
        Server server(tmp.path, {"--map-cache", "keep"}, on ? Env{} : Env{{"DSTNS_SUMO", "0"}});
        const auto info = server.op("GET", "/api/v1/system/info").body;
        EXPECT(info.at("sumo").at("enabled") == on, info);
        if (!on) EXPECT(info.at("sumo").at("available") == false && info.at("sumo").at("sumo_binary") == "", "not looked for");
        const auto started = server.op("POST", "/api/v1/playback/start", json{{"seed", "42"}, {"map", {{"osm_file", (root() / "data/fixtures/real_network.osm.xml").string()}}}});
        EXPECT(started.status == 202, show(started));
        until([&]() -> std::optional<bool> {
            const auto lifecycle = server.op("GET", "/api/v1/playback/status").data().at("lifecycle");
            return lifecycle == "RUNNING" || lifecycle == "PAUSED" ? std::optional<bool>(true) : std::nullopt;
        }, 60, "the world");
        const auto exported = server.op("POST", "/api/v1/export/sumo", json{{"directory", (tmp / "sumo_exp").string()}});
        const auto simulated = server.op("POST", "/api/v1/system/sumo-simulate", json{{"directory", (tmp / "sumo_run").string()}, {"end_s", 60}});
        if (on) {
            EXPECT(exported.status == 200, show(exported));
        } else {
            EXPECT(exported.status == 403 && exported.code() == "SUMO_DISABLED", show(exported));
            EXPECT(simulated.status == 403 && simulated.code() == "SUMO_DISABLED", show(simulated));
            EXPECT(!fs::exists(tmp / "sumo_exp"), "nothing written");
        }
    }
    std::cout << "sumo switch ok\n";
}
