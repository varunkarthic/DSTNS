// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The unstable-engine gate (docs/design/engine-governance.md): a start on core-ng (alpha) is held until a person
// accepts it; everything that would run the engine meanwhile is deferred with APPROVAL_REQUIRED, never run later
// behind the client's back; accepting runs the held start once; rejecting may start the same seed, and only the
// seed, on an enabled stable engine; the operator's stop cancels a start that waits; config/engines.json disables
// engines and turns enforcement or the observer's acknowledgment off.
#include "harness.hpp"

#include <fstream>
#include <future>

using namespace check;

namespace {
const Headers kObserver = {{"X-DSTNS-Host", "1"}};

json start_body(const std::string& engine, const std::string& seed = "42") {
    return {{"seed", seed}, {"engine", engine}, {"map", {{"osm_file", (root() / "data/fixtures/real_network.osm.xml").string()}}}};
}

json running(const Server& server) {
    return until([&]() -> std::optional<json> {
        const auto data = server.op("GET", "/api/v1/playback/status").body;
        const auto lifecycle = data.at("data").at("lifecycle");
        if (lifecycle == "RUNNING" || lifecycle == "PAUSED") return data;
        return std::nullopt;
    }, 60, "the world to run").value();
}

Reply decide(const Server& server, const std::string& id, const std::string& decision, const json& extra = json::object(), const Headers& who = kObserver) {
    json request = {{"approval_id", id}, {"decision", decision}};
    request.update(extra);
    return server.call("POST", "/api/v1/engine/approval", request, "", who);
}

fs::path policy_file(const TempDir& tmp, const json& engines) {
    const auto file = tmp / "engines.json";
    std::ofstream(file) << json{{"schema_version", 1}, {"engines", engines}}.dump();
    return file;
}
} // namespace

int main() {
    {
        TempDir tmp;
        Server server(tmp.path, {"--map-cache", "keep"}, {{"DSTNS_ENGINE_CONFIG", (tmp / "absent.json").string()}});
        // Each engine says what it is.
        const auto info = server.op("GET", "/api/v1/system/info").body;
        json ng, legacy;
        for (const auto& e : info.at("engine_catalogue")) (e.at("id") == "core-ng" ? ng : legacy) = e;
        EXPECT(ng.at("channel") == "alpha" && ng.at("kind") == "real" && !ng.at("version").get<std::string>().empty(), ng);
        EXPECT(legacy.at("channel") == "stable" && legacy.at("version") == info.at("version"), legacy);

        // An application, connected before anything starts, hears of every change to the approval.
        const auto registered = server.call("POST", "/api/v1/fabric/apps", json{{"id", "org.example.listener"}, {"name", "Listener"}, {"version", "1.0.0"}, {"capabilities", {"sim.read"}}});
        EXPECT(registered.status == 201, show(registered));
        const std::string app_token = registered.data().at("token");
        const auto heard = [&](const std::string& state) {
            for (const auto& e : json(server.call("GET", "/api/v1/fabric/apps/org.example.listener/events", none, app_token).data().at("items")))
                if (e.at("type") == "engine.approval" && e.at("data").at("state") == state) return true;
            return false;
        };

        // A start on core-ng is held, and nothing runs.
        const auto held = server.op("POST", "/api/v1/playback/start", start_body("core-ng"));
        EXPECT(held.status == 202 && held.data().at("state") == "approval_required" && held.data().at("deferred") == true, show(held));
        const std::string id = held.data().at("approval_id");
        EXPECT(server.op("GET", "/api/v1/playback/status").data().at("lifecycle") == "IDLE", "nothing started");

        // Anything that would run the engine is deferred, for an application and the operator alike.
        auto play = server.call("POST", "/api/v1/playback/play", json::object(), "", {{"Idempotency-Key", "play-1"}});
        EXPECT(play.status == 409 && play.code() == "APPROVAL_REQUIRED" && play.body.at("data").at("request_id") == "play-1" && play.body.at("data").at("approval_id") == id, show(play));
        EXPECT(server.op("POST", "/api/v1/world/regenerate", json::object()).code() == "APPROVAL_REQUIRED");
        EXPECT(server.op("GET", "/api/v1/playback/status").status == 200, "reading is never deferred");

        // One start waits at a time; the same request again is the same answer.
        EXPECT(server.op("POST", "/api/v1/playback/start", start_body("core-ng", "7")).code() == "APPROVAL_PENDING");
        // An application or anyone without the observer's header cannot decide.
        EXPECT(server.call("POST", "/api/v1/engine/approval", json{{"approval_id", id}, {"decision", "accept"}}).status == 401);
        EXPECT(decide(server, "nope", "accept").code() == "APPROVAL_NOT_FOUND");

        // A long poll returns when the decision is made.
        const auto revision = server.op("GET", "/api/v1/engine/approval").data().at("revision").get<std::uint64_t>();
        auto waited = std::async(std::launch::async, [&] { return server.call("GET", "/api/v1/engine/approval/wait?since=" + std::to_string(revision) + "&timeout=20", none, "", {}, 30); });
        const auto accepted = decide(server, id, "accept");
        EXPECT(accepted.status == 200 && accepted.data().at("state") == "accepted" && accepted.data().contains("started"), show(accepted));
        EXPECT(waited.get().data().at("state") == "accepted");
        EXPECT(heard("pending") && heard("accepted"), "the application was told the start waited, and when it could retry");
        const auto status = running(server);
        EXPECT(status.at("data").at("engine_identity").at("id") == "core-ng" && status.at("data").at("engine_identity").at("channel") == "alpha", status);
        EXPECT(server.op("GET", "/api/v1/engine").data().at("running").at("id") == "core-ng");
        // Deciding again: the same decision is the same answer, the other is too late. The run is not started twice.
        EXPECT(decide(server, id, "accept").status == 200);
        EXPECT(decide(server, id, "reject").code() == "APPROVAL_DECIDED");
        EXPECT(server.op("POST", "/api/v1/playback/pause", json::object()).status == 200, "once accepted, the run is operated as any other");

        // Rejected: the same seed, and only the seed, on a stable engine. core-ng itself is never offered.
        server.op("POST", "/api/v1/playback/stop", json::object());
        auto again = server.op("POST", "/api/v1/playback/start", start_body("core-ng", "382923"));
        const std::string second = again.data().at("approval_id");
        EXPECT(second != id, "every run is acknowledged afresh");
        const auto offered = server.op("GET", "/api/v1/engine/approval").data().at("alternatives");
        EXPECT(offered.size() == 1 && offered[0].at("id") == "core-legacy", offered);
        EXPECT(decide(server, second, "reject", {{"then", "regenerate"}, {"engine", "core-ng"}}).code() == "ENGINE_NOT_OFFERED");
        const auto regenerated = decide(server, second, "reject", {{"then", "regenerate"}, {"engine", "core-legacy"}});
        EXPECT(regenerated.status == 200 && regenerated.data().at("state") == "rejected", show(regenerated));
        const auto replaced = running(server);
        EXPECT(replaced.at("seed") == "382923" && replaced.at("data").at("engine") == "core-legacy", replaced);

        // The operator's stop cancels a start that waits; a core-legacy start is never held.
        auto third = server.op("POST", "/api/v1/playback/start", start_body("core-ng"));
        EXPECT(third.data().at("state") == "approval_required");
        server.op("POST", "/api/v1/playback/stop", json::object());
        EXPECT(server.op("GET", "/api/v1/engine/approval").data().at("state") == "cancelled");
        EXPECT(server.op("POST", "/api/v1/playback/start", start_body("core-legacy")).data().value("state", "") != "approval_required");
    }
    {
        // A disabled engine is installed but cannot start; enforcement off runs it at once.
        TempDir tmp;
        Server server(tmp.path, {"--map-cache", "keep"}, {{"DSTNS_ENGINE_CONFIG", policy_file(tmp, {{"core-ng", {{"enabled", false}}}}).string()}});
        const auto disabled = server.op("POST", "/api/v1/playback/start", start_body("core-ng"));
        EXPECT(disabled.code() == "ENGINE_DISABLED", show(disabled) + " " + read(tmp / "engines.json") + " " + read(tmp / "system.log"));
    }
    {
        TempDir tmp;
        Server server(tmp.path, {"--map-cache", "keep"}, {{"DSTNS_ENGINE_CONFIG", policy_file(tmp, {{"core-ng", {{"acknowledgment", {{"enforce", false}}}}}}).string()}});
        EXPECT(server.op("POST", "/api/v1/playback/start", start_body("core-ng")).data().value("state", "") != "approval_required");
        EXPECT(running(server).at("data").at("engine") == "core-ng");
    }
    {
        // The observer's acknowledgment off, enforcement on: only the operator (the launcher) decides.
        TempDir tmp;
        Server server(tmp.path, {"--map-cache", "keep"}, {{"DSTNS_ENGINE_CONFIG", policy_file(tmp, {{"core-ng", {{"acknowledgment", {{"ui", false}, {"enforce", true}}}}}}).string()}});
        const auto held = server.op("POST", "/api/v1/playback/start", start_body("core-ng"));
        EXPECT(held.data().at("acknowledge_in") == "launcher", show(held));
        const std::string id = held.data().at("approval_id");
        EXPECT(decide(server, id, "accept").code() == "ACKNOWLEDGE_IN_LAUNCHER");
        EXPECT(decide(server, id, "accept", json::object(), server.host).status == 200);
    }
    std::cout << "engine gate ok\n";
}
