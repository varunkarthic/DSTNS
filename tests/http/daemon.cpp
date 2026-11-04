// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The daemons, on a real server: what anyone may see, who may read the queues, an alert from the Resource Control
// Subsystem heard and acknowledged by an application, a daemon turned off, the cache handler keeping only what is
// needed, and all of it off.
#include "harness.hpp"

using namespace check;

int main() {
    TempDir tmp("dstns-daemon-");
    const auto maps = tmp / "maps";
    fs::create_directories(maps);
    // A cache with something of everything: the next world's city, an old one, an abandoned download, a stray manifest.
    write(maps / "next-world.json", json{{"seed", "1"}, {"city", "Lisbon"}, {"key", "lisbon_x5000"}, {"extent_m", 5000.0}, {"state", "ready"}}.dump());
    write(maps / "lisbon_x5000.osm.xml", std::string(4096, 'x'));
    write(maps / "oldtown_x5000.osm.xml", std::string(4096, 'x'));
    write(maps / "oldtown_x5000.osm.manifest.json", "{}");
    write(maps / "paris_x5000.osm.xml.123.part", "partial");
    write(maps / "ghost_x5000.osm.manifest.json", "{}");
    const json settings = {{"sustain_s", 0.5}, {"cache", {{"interval_s", 1}, {"max_mib", 0}, {"stale_part_s", 0}}}};
    Server server(tmp / "logs", {"--maps", maps.string(), "--map-cache", "keep"}, {{"DSTNS_DAEMON", settings.dump()}});

    // Anyone may ask what runs, without a token.
    const auto overview = *until([&]() -> std::optional<json> {
        const auto d = server.call("GET", "/api/v1/daemon").data();
        const auto running = std::count_if(d.at("daemons").begin(), d.at("daemons").end(), [](const json& x) { return x.at("running").get<bool>(); });
        if (running == 5) return d;
        return std::nullopt;
    }, 10, "every daemon running");
    EXPECT(overview.at("enabled") == true && overview.at("queues").contains("daemonEmergencyQueue") && overview.at("queues").contains("daemonNotificationQueue"), overview);
    EXPECT(server.call("GET", "/api/v1/daemon/messages").data().at("messages").contains("rcs.over_gamma"));

    // The queues are for the observer, the operator, and applications that say who they are.
    EXPECT(server.call("GET", "/api/v1/daemon/emergency-queue").status == 401);
    EXPECT(server.call("GET", "/api/v1/daemon/emergency-queue?app=org.nobody", none, "not-a-token").status == 404, "no such application");
    const auto registered = server.call("POST", "/api/v1/fabric/apps", json{{"id", "org.test.listener"}, {"name", "Listener"}, {"version", "1.0.0"}, {"capabilities", json::array()}});
    EXPECT(registered.status == 201, registered);
    const std::string token = registered.data().at("token");
    EXPECT(server.call("GET", "/api/v1/daemon/emergency-queue?app=org.test.listener", none, "not-its-token").status == 401);
    EXPECT(server.call("GET", "/api/v1/daemon/emergency-queue?app=org.test.listener", none, token).status == 200);
    const auto subscribers = server.call("GET", "/api/v1/daemon").data().at("queues").at("daemonEmergencyQueue").at("subscribers");
    EXPECT(std::find(subscribers.begin(), subscribers.end(), "org.test.listener") != subscribers.end(), "reading is subscribing", subscribers);

    // The cache handler: over its budget of nothing, everything goes but the next world's city, abandoned downloads and
    // stray manifests with it.
    until([&] { return !fs::exists(maps / "oldtown_x5000.osm.xml"); }, 10, "the cache to be swept");
    EXPECT(fs::exists(maps / "lisbon_x5000.osm.xml"), "the next world's city is kept");
    EXPECT(!fs::exists(maps / "paris_x5000.osm.xml.123.part") && !fs::exists(maps / "ghost_x5000.osm.manifest.json") && !fs::exists(maps / "oldtown_x5000.osm.manifest.json"));
    const auto news = server.op("GET", "/api/v1/daemon/notification-queue").data().at("items");
    EXPECT(std::any_of(news.begin(), news.end(), [](const json& m) { return m.at("id") == "cache.swept" && m.at("level") == "info"; }), news);

    // The Resource Control Subsystem, with limits the engine is already over: an alert, at once on the emergency queue,
    // and a reader waiting on it hears it as it comes.
    const auto latest = server.op("GET", "/api/v1/daemon/emergency-queue").data().at("latest_sequence").get<std::uint64_t>();
    EXPECT(server.call("PUT", "/api/v1/daemon/rcs", json{{"enabled", false}}).status == 403, "only the operator changes them");
    EXPECT(server.op("PUT", "/api/v1/daemon/rcs", json{{"settings", {{"modules", {{"engine", {{"memory_mib", {1, 2, 3}}}}}}}}}).status == 200);
    const auto heard = server.call("GET", "/api/v1/daemon/emergency-queue?app=org.test.listener&wait=10&since=" + std::to_string(latest), none, token, {}, 15).data().at("items");
    EXPECT(heard.size() == 1 && heard[0].at("id") == "rcs.over_gamma" && heard[0].at("level") == "alert" && heard[0].at("data").at("module") == "engine", heard);
    EXPECT(heard[0].at("text").get<std::string>().find("γ") != std::string::npos, "the template is filled in", heard[0]);
    const auto sequence = heard[0].at("sequence").get<std::uint64_t>();
    EXPECT(server.call("POST", "/api/v1/daemon/emergency-queue/" + std::to_string(sequence) + "/ack?app=org.test.listener", json::object(), token).status == 200);
    const auto acknowledged = server.op("GET", "/api/v1/daemon/emergency-queue?since=" + std::to_string(latest)).data().at("items").at(0).at("acknowledged_by");
    EXPECT(acknowledged == json::array({"org.test.listener"}), acknowledged);

    // Processes the launcher reports, watched with the rest.
    EXPECT(server.op("PUT", "/api/v1/daemon/rcs/processes", json{{"module", "launcher"}, {"pids", {static_cast<int>(::getpid())}}}).status == 200);
    until([&] { return server.op("GET", "/api/v1/daemon/rcs").data().at("readings").value("launcher", json::object()).value("pids", json::array()).size() == 1; }, 10, "the launcher's process to be read");
    EXPECT(server.op("PUT", "/api/v1/daemon/rcs/processes", json{{"module", "engine"}, {"pids", {1}}}).status == 400, "the engine is found, not reported");

    // Turned off, it says so, and stops.
    EXPECT(server.op("PUT", "/api/v1/daemon/rcs", json{{"enabled", false}}).status == 200);
    const auto off = server.op("GET", "/api/v1/daemon/notification-queue").data().at("items");
    EXPECT(std::any_of(off.begin(), off.end(), [](const json& m) { return m.at("id") == "daemon.disabled" && m.at("data").at("daemon") == "rcs"; }), off);
    const auto listed = server.call("GET", "/api/v1/daemon").data().at("daemons");
    EXPECT(std::any_of(listed.begin(), listed.end(), [](const json& d) { return d.at("name") == "rcs" && d.at("enabled") == false; }));
    EXPECT(server.op("GET", "/api/v1/daemon/nothing").status == 404);

    // All of it off.
    TempDir quiet("dstns-daemon-off-");
    Server none_running(quiet.path, {}, {{"DSTNS_DAEMON", json{{"enabled", false}}.dump()}});
    EXPECT(none_running.call("GET", "/api/v1/daemon").data().at("enabled") == false);
    EXPECT(none_running.op("GET", "/api/v1/daemon/emergency-queue").status == 409);
    std::cout << "daemon ok: open overview, queues by token, an RCS alert heard and acknowledged, the cache kept, off when told\n";
}
