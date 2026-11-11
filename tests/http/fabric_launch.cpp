// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// What the operator can turn on and off, web applications, components on a grid, and reloading an application.
//
// Each switch is tried on a server of its own, since they are read once at start.
#include "harness.hpp"

#include <set>

using namespace check;

namespace {

const std::string BASE = "/api/v1/fabric/apps";

json merged(json base, const json& extra) {
    base.update(extra);
    return base;
}

std::set<std::string> as_set(const json& list) { return {list.begin(), list.end()}; }

void out_of_the_box() {
    TempDir tmp;
    Server s(tmp.path);
    const auto features = s.call("GET", "/api/v1/system/features").data();
    EXPECT(features.at("applications") == true && features.at("legacy_api") == true && features.at("launch_proposals") == true && features.at("require_signatures") == false, features);
    EXPECT(features.at("presentation") == (json{{"webfabric", true}, {"force_animate", false}, {"fast_boot", false}, {"dynamic_fastboot", true}, {"dynamic_particles", true},
                                                {"demo", false}, {"music", false}, {"music_track", false}, {"fullscreen", false}, {"music_volume", 0.6}, {"map_fps", 0}, {"render_scale", 2.0},
                                                {"film_particles", 32000}}), features);
    EXPECT(features.at("performance") == (json{{"compression", "fast"}, {"api_threads", "auto"}, {"engine_threads", "auto"}}), features);
    EXPECT(s.call("GET", "/api/v1/playback/status").status == 200);

    // A web interface of its own, opened in a tab, and only over http or https.
    const json app = {{"id", "org.test.web"}, {"name", "Web"}, {"version", "1.0.0"}, {"capabilities", {"ui.panels", "ui.camera"}},
                      {"web", {{"url", "http://127.0.0.1:5173/"}, {"label", "Open planner"}}}};
    const auto made = s.call("POST", BASE, app);
    EXPECT(made.status == 201 && made.data().at("app").at("web") == app.at("web"), made);
    for (const json& wrong : {json{{"url", "javascript:alert(1)"}}, json{{"url", "file:///etc/passwd"}}, json{{"label", "x"}}, json("http://x"),
                              json{{"url", "http://x"}, {"label", std::string(41, 'x')}}}) {
        const auto refused = s.call("POST", BASE, merged(app, {{"id", "org.test.webx"}, {"web", wrong}}));
        EXPECT(refused.status == 400 && refused.code() == "INVALID_MANIFEST", wrong, refused);
    }
    const std::string token = made.data().at("token");

    // Components on a grid.
    const json good = {{"id", "board"}, {"slot", "panel"}, {"title", "Board"}, {"layout", {{"columns", 6}}}, {"widgets", {
        {{"type", "metric"}, {"label", "Buses"}, {"value", "12"}, {"area", {{"column", 1}, {"row", 1}, {"width", 3}, {"height", 1}}}},
        {{"type", "link"}, {"label", "Open"}, {"url", "https://example.org/"}, {"area", {{"column", 4}, {"width", 3}}}},
        {{"type", "qr"}, {"label", "On your phone"}, {"url", "https://example.org/ticket?seat=12A"}},
        {{"type", "seats"}, {"caption", "Front"}, {"columns_count", 4}, {"aisle", 2}, {"seats", {{{"id", "s1"}, {"label", "1A"}, {"state", "free"}}, {{"id", "s2"}, {"label", "1B"}, {"state", "taken"}}}}},
        {{"type", "combobox"}, {"label", "From"}, {"choices", {{{"value", "12"}, {"label", "Central"}, {"caption", "Stop 12"}}}}},
        {{"type", "player"}, {"position", 2}, {"steps", 5}, {"playing", false}, {"caption", "Line 2 accepted"}},
        {{"type", "form"}, {"submit", "Validate"}, {"fields", {{{"id", "ticket"}, {"label", "Ticket"}}, {{"id", "bus"}, {"label", "Bus"}, {"kind", "select"}, {"options", {{{"value", "1"}, {"label", "R1"}}}}}}}},
        {{"type", "countdown"}, {"label", "Held for"}, {"until", 1893456000000.0}},
        {{"type", "notice"}, {"tone", "danger"}, {"text", "The algorithm is not answering."}, {"action", "Try again"}},
        {{"type", "code"}, {"lines_text", {"started", "listening on 8080"}}},
        {{"type", "empty"}, {"figure", "junction"}, {"label", "No journeys yet"}},
        {{"type", "tabs"}, {"tabs", {{{"id", "a"}, {"label", "A"}, {"widgets", {{{"type", "chart"}, {"series", {{{"label", "x"}, {"points", {1, 2, 3}}}}}}}}}}}}}}};
    EXPECT(s.call("PUT", BASE + "/org.test.web/ui/board", good, token).status == 200);
    json nested = {{"type", "card"}, {"widgets", json::array()}};
    for (int depth = 0; depth < 4; ++depth) nested = {{"type", "card"}, {"widgets", {nested}}};
    for (const json& wrong : {json{{"layout", {{"columns", 13}}}}, json{{"widgets", {{{"type", "link"}, {"url", "javascript:x"}}}}}, json{{"widgets", {{{"type", "text"}, {"area", {{"column", 0}}}}}}},
                              json{{"widgets", {{{"type", "text"}, {"area", {{"width", 13}}}}}}}, json{{"widgets", {{{"text", "no type"}}}}}, json{{"widgets", {nested}}},
                              json{{"widgets", {{{"type", "qr"}}}}}, json{{"widgets", {{{"type", "qr"}, {"text", std::string(214, 'x')}}}}},
                              json{{"widgets", {{{"type", "countdown"}}}}}, json{{"widgets", {{{"type", "form"}, {"fields", {{{"label", "no id"}}}}}}}},
                              json{{"widgets", {{{"type", "code"}, {"lines_text", "not a list"}}}}}}) {
        const auto refused = s.call("PUT", BASE + "/org.test.web/ui/board", merged(good, wrong), token);
        EXPECT(refused.status == 400 && refused.code() == "INVALID_ELEMENT", wrong, refused);
    }

    // Reloading something the launcher did not start: its link ends, and it starts again as new.
    EXPECT(s.op("PUT", BASE + "/org.test.web/grants", json{{"capabilities", {"ui.panels", "ui.camera"}}}).status == 200);
    EXPECT(s.call("POST", BASE + "/org.test.web/reload", json::object(), token).status == 403, "only a person reloads");
    const auto reloaded = s.op("POST", BASE + "/org.test.web/reload", json::object());
    EXPECT(reloaded.status == 200 && reloaded.data().at("managed") == false, reloaded);
    EXPECT(s.call("POST", BASE + "/org.test.web/heartbeat", json::object(), token).status == 401, "the old link is gone");
    const auto state = s.call("GET", "/api/v1/fabric/state").data();
    EXPECT(state.at("reloads").back().at("app") == "org.test.web" && state.at("reload_sequence") >= 1, state);
    const auto again = s.call("POST", BASE, app);
    EXPECT(again.status == 201 && again.data().at("token") != token, again);
    EXPECT(!as_set(again.data().at("app").at("capabilities").at("granted")).contains("ui.camera"), "nobody could prove to be it, so a person grants again");

    // Reloading something the launcher started: it comes back with the launcher's key, and keeps its grants and storage.
    const json managed = {{"id", "org.test.managed"}, {"name", "Managed"}, {"version", "1.0.0"}, {"capabilities", {"ui.camera", "storage"}}};
    const std::string token_m = s.call("POST", BASE, managed).data().at("token");
    EXPECT(s.op("PUT", BASE + "/org.test.managed/grants", json{{"capabilities", {"ui.camera", "storage"}}}).status == 200);
    EXPECT(s.call("PUT", BASE + "/org.test.managed/storage/k", json{{"value", 7}}, token_m).status == 200);
    EXPECT(s.op("PUT", "/api/v1/fabric/launch/plan", json{{"apps", {{{"id", "org.test.managed"}, {"name", "Managed"}, {"state", "ready"}}}}}).status == 200);
    EXPECT(s.op("PUT", "/api/v1/fabric/launch/org.test.managed/key", json{{"key_sha256", "x"}}).status == 400);
    EXPECT(s.call("PUT", "/api/v1/fabric/launch/org.test.managed/key", json{{"key_sha256", std::string(64, '0')}}, token_m).status == 403, "only the launcher");
    EXPECT(s.op("POST", BASE + "/org.test.managed/reload", json::object()).data().at("managed") == true);
    EXPECT(s.call("GET", BASE + "/org.test.managed").data().at("state") == "reloading");
    const auto key = random_hex(32);
    EXPECT(s.op("PUT", "/api/v1/fabric/launch/org.test.managed/key", json{{"key_sha256", sha256_hex(key)}}).status == 200);
    const auto wrong_key = s.call("POST", BASE, managed, "", {{"X-DSTNS-Launch-Key", random_hex(32)}});
    EXPECT(wrong_key.status == 409 && wrong_key.code() == "APP_ID_CONFLICT", wrong_key);
    const auto back = s.call("POST", BASE, managed, "", {{"X-DSTNS-Launch-Key", key}});
    EXPECT(back.status == 201, back);
    EXPECT((as_set(back.data().at("app").at("capabilities").at("granted")) == std::set<std::string>{"ui.camera", "storage"}), "it kept what a person gave it");
    const auto kept = s.call("GET", BASE + "/org.test.managed/storage/k", none, back.data().at("token")).data().at("value");
    EXPECT(kept == 7 || kept == (json{{"value", 7}}), "storage kept", kept);
    EXPECT(s.call("POST", BASE + "/org.test.managed/heartbeat", json::object(), token_m).status == 401);
    EXPECT(s.call("POST", BASE, managed, "", {{"X-DSTNS-Launch-Key", key}}).status == 409, "a launch key works once");
}

void switched_off() {
    TempDir tmp;
    Server s(tmp.path, {}, {{"DSTNS_LEGACY_API", "0"}, {"DSTNS_FABRIC_APPS", "0"}, {"DSTNS_LAUNCH_PROPOSALS", "0"},
                            {"DSTNS_DISABLED_CAPABILITIES", "control.world, ui.frames, nonsense"},
                            {"DSTNS_PRESENTATION", json{{"fast_boot", true}, {"music", true}, {"fullscreen", "yes"}, {"music_volume", 3}, {"junk", 1}, {"demo_scenes", {"ai-ready", "streets", 5}}}.dump()}});
    const auto features = s.call("GET", "/api/v1/system/features").data();
    EXPECT(features.at("legacy_api") == false && features.at("applications") == false && features.at("launch_proposals") == false, features);
    EXPECT((as_set(features.at("disabled_capabilities")) == std::set<std::string>{"control.world", "ui.frames"}), features);
    const auto p = features.at("presentation");
    EXPECT(p.at("demo_scenes") == json::array({"ai-ready", "streets"}), "Demo Mode's scenes, strings only, in order", p);
    // The dynamic film, on by default, and the whole film are never on together.
    EXPECT(p.at("dynamic_particles") == true && p.at("force_animate") == false, p);
    EXPECT(p.at("fast_boot") == true && p.at("music") == true && p.at("force_animate") == false && p.at("fullscreen") == false && p.at("music_volume") == 1 && !p.contains("junk"), p);
    const auto gone = s.call("GET", "/api/v1/playback/status");
    EXPECT(gone.status == 410 && gone.code() == "LEGACY_API_DISABLED", gone);
    EXPECT(s.call("POST", "/api/v1/control/day", json{{"day", 1}}).status == 410);
    EXPECT(s.call("GET", "/api/v1/fabric/engine/status").status == 200, "the Fabric API answers");
    const auto refused = s.call("POST", BASE, json{{"id", "org.test.x"}, {"name", "X"}, {"version", "1.0.0"}});
    EXPECT(refused.status == 403 && refused.code() == "APPLICATIONS_DISABLED", refused);
    EXPECT(s.call("GET", BASE).status == 200);
    EXPECT(s.call("GET", "/api/v1/fabric/capabilities").data().at("switches").at("disabled_capabilities") == json::array({"control.world", "ui.frames"}));
}

void signatures_required() {
    TempDir tmp;
    Server s(tmp.path, {}, {{"DSTNS_REQUIRE_SIGNATURES", "1"}, {"DSTNS_DISABLED_CAPABILITIES", "control.world"}, {"DSTNS_LAUNCH_PROPOSALS", "0"}, {"DSTNS_PRESENTATION", "not json"}});
    EXPECT(s.call("GET", "/api/v1/system/features").data().at("presentation").at("fast_boot") == false, "a malformed setting leaves the defaults");
    const auto made = s.call("POST", BASE, json{{"id", "org.test.s"}, {"name", "S"}, {"version", "1.0.0"}, {"capabilities", {"control.world", "control.playback"}}}).data();
    EXPECT(made.at("app").at("security").at("signatures_required") == true);
    const auto unsigned_call = s.call("POST", BASE + "/org.test.s/heartbeat", json::object(), made.at("token"));
    EXPECT(unsigned_call.status == 401 && unsigned_call.code() == "SIGNATURE_REQUIRED", unsigned_call);
    const auto refused = s.op("PUT", BASE + "/org.test.s/grants", json{{"capabilities", {"control.world"}}});
    EXPECT(refused.status == 403 && refused.code() == "CAPABILITY_DISABLED", refused);
    EXPECT(s.op("PUT", BASE + "/org.test.s/grants", json{{"capabilities", {"control.playback"}}}).status == 200);
    const auto proposal = s.call("PUT", BASE + "/org.test.s/launch", json{{"commands", {"x"}}}, made.at("token")).status;
    EXPECT(proposal == 401 || proposal == 403, proposal);
    EXPECT(s.op("PUT", "/api/v1/fabric/launch/org.test.s", json{{"commands", {"x"}}}).status == 200, "the operator still can");
}

void the_whole_film() {
    TempDir tmp;
    Server s(tmp.path, {}, {{"DSTNS_PRESENTATION", json{{"dynamic_particles", false}, {"force_animate", true}}.dump()}});
    const auto p = s.call("GET", "/api/v1/system/features").data().at("presentation");
    EXPECT(p.at("force_animate") == true && p.at("dynamic_particles") == false, "the whole film, with the dynamic film off", p);
}

} // namespace

int main() {
    out_of_the_box();
    switched_off();
    signatures_required();
    the_whole_film();
    std::cout << "fabric launch ok\n";
}
