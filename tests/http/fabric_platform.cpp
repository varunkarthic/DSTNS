// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// What Fabric gives an application beyond its own surfaces, against a real server and a real run.
//
// Discovery, atomic UI batches, the application's own store across a restart, messages between applications,
// subscriptions to the simulation, timers on its clock, health, request signing, frames, the audit chain and launch
// proposals.
#include "harness.hpp"
#include "support.hpp"

#include <sys/stat.h>

#include <memory>
#include <set>

using namespace check;

namespace {

const std::string BASE = "/api/v1/fabric/apps";

json manifest(const std::string& id, json capabilities = json::array()) {
    std::string name = id.substr(id.rfind('.') + 1);
    name[0] = static_cast<char>(std::toupper(name[0]));
    return {{"id", id}, {"name", name}, {"version", "1.0.0"}, {"capabilities", capabilities}};
}

json status(const std::string& id, const std::string& text = "on") { return {{"id", id}, {"slot", "status"}, {"text", text}}; }

bool has(const json& list, const std::string& item) { return std::find(list.begin(), list.end(), item) != list.end(); }

Headers signed_headers(const std::string& key, const std::string& method, const std::string& target, const std::string& payload = "",
                       std::optional<long long> timestamp = std::nullopt) {
    const auto moment = std::to_string(timestamp.value_or(std::time(nullptr)));
    const auto nonce = random_hex(12);
    const auto message = method + "\n" + target + "\n" + moment + "\n" + nonce + "\n" + sha256_hex(payload);
    return {{"X-DSTNS-Timestamp", moment}, {"X-DSTNS-Nonce", nonce}, {"X-DSTNS-Signature", dstns::fabric::hmac_sha256(key, message)}};
}

void security_checks(const Server& server, const std::string& token_a) {
    const auto call = [&](const std::string& method, const std::string& route, std::optional<json> data = none, const std::string& token = "", Headers headers = {}) {
        return server.call(method, route, data, token, headers);
    };
    const Headers host = {{"X-DSTNS-Host", "observer"}};
    // Tokens are not on disk, only their hashes, and the store is sealed.
    const auto stored = read(server.logs / "fabric-apps.json");
    const auto store = json::parse(stored);
    EXPECT(!contains(stored, token_a) && store.contains("integrity") && !store.at("apps").at("org.test.alpha").at("token_hash").get<std::string>().empty());
    struct stat info {};
    ::stat((server.logs / "fabric-apps.json.key").c_str(), &info);
    EXPECT((info.st_mode & 0777) == 0600, info.st_mode & 0777);

    // An application that asks for signing cannot be driven by its token alone.
    auto made = manifest("org.test.signed", {"storage", "sim.read"});
    made["security"] = {{"require_signatures", true}};
    const auto reply = call("POST", BASE, made);
    EXPECT(reply.status == 201, reply);
    const std::string token = reply.data().at("token"), key = reply.data().at("signing_key");
    const auto route = BASE + "/org.test.signed/storage/k";
    EXPECT(call("GET", route, none, token).code() == "SIGNATURE_REQUIRED");
    const std::string payload = json{{"v", 1}}.dump();
    auto headers = signed_headers(key, "PUT", route, payload);
    headers["Authorization"] = "Bearer " + token;
    const auto put = server.raw("PUT", route, payload, headers);
    EXPECT(put.status == 200, put);
    // The response is signed in return, and its digest is of what was sent.
    const auto digest = put.header("X-DSTNS-Content-SHA256");
    EXPECT(digest == sha256_hex(put.text), digest);
    EXPECT(put.header("X-DSTNS-Response-Signature") == dstns::fabric::hmac_sha256(key, "200\n" + headers["X-DSTNS-Nonce"] + "\n" + digest));
    // The same request again is a replay; a changed one, an old one or a guessed one is refused too.
    EXPECT(call("GET", route, none, token, signed_headers(key, "GET", route)).code() != "SIGNATURE_INVALID");
    const auto replay = signed_headers(key, "GET", route);
    EXPECT(call("GET", route, none, token, replay).status == 200);
    EXPECT(call("GET", route, none, token, replay).code() == "SIGNATURE_REPLAYED");
    const auto changed = call("GET", route, none, token, signed_headers(key, "GET", route + "x")).code();
    EXPECT(changed == "SIGNATURE_INVALID" || changed == "KEY_NOT_FOUND", changed);
    EXPECT(call("GET", route, none, token, signed_headers("wrong", "GET", route)).code() == "SIGNATURE_INVALID");
    EXPECT(call("GET", route, none, token, signed_headers(key, "GET", route, "", std::time(nullptr) - 600)).code() == "SIGNATURE_EXPIRED");

    // Rotating replaces both at once.
    const auto rotate = BASE + "/org.test.signed/credentials/rotate";
    const auto fresh = call("POST", rotate, json::object(), token, signed_headers(key, "POST", rotate, "{}")).data();
    EXPECT(fresh.at("token") != token && fresh.at("signing_key") != key, fresh);
    EXPECT(call("GET", route, none, token, signed_headers(key, "GET", route)).code() == "APP_TOKEN_INVALID");
    EXPECT(call("GET", route, none, fresh.at("token"), signed_headers(fresh.at("signing_key"), "GET", route)).status == 200);

    // A frame comes only from where the manifest says, and asking for more asks a person again.
    auto frames = manifest("org.test.framed", {"ui.frames", "ui.panels"});
    frames["frame_origins"] = {"https://a.example"};
    const std::string token_f = call("POST", BASE, frames).data().at("token");
    const auto base_f = BASE + "/org.test.framed";
    EXPECT(call("PUT", base_f + "/ui/p", json{{"slot", "panel"}, {"frame", "https://a.example/x"}}, token_f).status == 200);
    EXPECT(call("PUT", base_f + "/ui/q", json{{"slot", "panel"}, {"frame", "https://evil.example/x"}}, token_f).code() == "FRAME_ORIGIN_NOT_DECLARED");
    EXPECT(call("PUT", base_f + "/ui/r", json{{"slot", "panel"}, {"frame", "https://a.example.evil.example/x"}}, token_f).code() == "FRAME_ORIGIN_NOT_DECLARED");
    EXPECT(call("PUT", base_f + "/grants", json{{"capabilities", {"ui.frames", "ui.panels"}}}, "", host).status == 200);
    EXPECT(has(call("POST", BASE, frames, token_f).data().at("app").at("capabilities").at("granted"), "ui.frames"), "the same origins keep the permission");
    frames["frame_origins"] = {"https://a.example", "https://b.example"};
    const auto wider = call("POST", BASE, frames, token_f).data().at("app").at("capabilities");
    EXPECT(!has(wider.at("granted"), "ui.frames") && has(wider.at("pending"), "ui.frames"), wider);

    // The audit log is a chain, which can be checked.
    const std::string token_c = call("POST", BASE, manifest("org.test.auditor", {"control.playback"})).data().at("token");
    EXPECT(call("PUT", BASE + "/org.test.auditor/grants", json{{"capabilities", {"control.playback"}}}, "", host).status == 200);
    for (const char* action : {"pause", "play"}) EXPECT(call("POST", BASE + "/org.test.auditor/control", json{{"action", action}}, token_c).status == 200);
    const auto entries = call("GET", "/api/v1/fabric/audit").data().at("items");
    EXPECT(entries[entries.size() - 1].at("previous") == entries[entries.size() - 2].at("hash"));
    EXPECT(call("GET", "/api/v1/fabric/audit/verify", none, "", host).data().at("intact") == true);
    EXPECT(call("GET", "/api/v1/fabric/audit/verify").status == 403);
    const auto posture = call("GET", "/api/v1/fabric/security", none, "", server.host).data();
    EXPECT(posture.at("store").at("tokens") == "hashed" && posture.at("audit").at("verification").at("intact") == true && posture.at("transport").at("tls") == false, posture);
    EXPECT(call("GET", "/api/v1/fabric/security").status == 403);

    // A launch is only ever proposed. The application, for itself, or the operator, for any.
    EXPECT(call("PUT", BASE + "/org.test.alpha/launch", json{{"commands", json::array()}}, token_a).code() == "INVALID_LAUNCH");
    EXPECT(call("PUT", BASE + "/org.test.alpha/launch", json{{"commands", {"python3 app.py"}}}, token_a).data().at("proposed_by") == "application");
    EXPECT(call("PUT", "/api/v1/fabric/launch/org.test.other", json{{"commands", {"x"}}}).status == 403, "not without being the operator");
    EXPECT(call("PUT", "/api/v1/fabric/launch/org.test.other", json{{"commands", {"x"}}}, "", server.host).data().at("proposed_by") == "operator");
    std::set<std::string> listed;
    for (const auto& proposal : json(call("GET", "/api/v1/fabric/launch", none, "", server.host).data().at("items"))) listed.insert(proposal.at("id"));
    EXPECT((listed == std::set<std::string>{"org.test.alpha", "org.test.other"}), json(listed));
    EXPECT(call("GET", "/api/v1/fabric/launch").status == 403);
    EXPECT(call("DELETE", "/api/v1/fabric/launch/org.test.other", none, "", server.host).status == 200);
    // And the observer can be told what is being started.
    const json plan = {{"apps", {{{"id", "x"}, {"name", "X"}, {"state", "starting"}}}}};
    EXPECT(call("PUT", "/api/v1/fabric/launch/plan", plan).status == 403);
    EXPECT(call("PUT", "/api/v1/fabric/launch/plan", plan, "", server.host).status == 200);
    EXPECT(call("GET", "/api/v1/fabric/state?since=999999999").data().at("launch_plan").at("apps")[0].at("id") == "x", "whether or not anything else changed");
    EXPECT(call("DELETE", "/api/v1/fabric/launch/plan", none, "", server.host).status == 200);
}

} // namespace

int main() {
    TempDir tmp;
    auto server = std::make_unique<Server>(tmp.path);
    const auto call = [&](const std::string& method, const std::string& route, std::optional<json> data = none, const std::string& token = "", Headers headers = {}) {
        return server->call(method, route, data, token, headers);
    };
    // Discovery says what there is, without an application or a token.
    const auto found = call("GET", "/api/v1/fabric/capabilities").data();
    EXPECT(has(found.at("capabilities").at("automatic"), "storage") && has(found.at("capabilities").at("needs_a_person"), "control.playback"));
    for (const char* widget : {"table", "gauge", "bars", "keyvalues"}) EXPECT(has(found.at("widgets"), widget), widget);
    EXPECT(found.at("limits").at("storage_bytes") > 0);

    const auto alpha_manifest = manifest("org.test.alpha", {"sim.read", "storage", "apps.messages", "ui.status"});
    const auto made_a = call("POST", BASE, alpha_manifest);
    EXPECT(made_a.status == 201, made_a);
    const std::string token_a = made_a.data().at("token");
    const std::string token_b = call("POST", BASE, manifest("org.test.beta", {"sim.read", "storage", "apps.messages"})).data().at("token");
    const std::string token_c = call("POST", BASE, manifest("org.test.gamma", {"ui.status"})).data().at("token");
    const auto alpha = BASE + "/org.test.alpha", beta = BASE + "/org.test.beta", gamma = BASE + "/org.test.gamma";

    // A batch applies whole or not at all.
    EXPECT(call("POST", alpha + "/ui/batch", json{{"upsert", {status("one"), status("two")}}}, token_a).status == 200);
    EXPECT(call("POST", alpha + "/ui/batch", json{{"upsert", {status("three")}}, {"remove", {"missing"}}}, token_a).status == 404);
    std::set<std::string> ids;
    for (const auto& app : json(call("GET", "/api/v1/fabric/state").data().at("apps"))) {
        if (app.at("id") != "org.test.alpha") continue;
        for (const auto& element : app.at("ui")) ids.insert(element.at("id"));
    }
    EXPECT((ids == std::set<std::string>{"one", "two"}), json(ids));
    EXPECT(call("POST", alpha + "/ui/batch", json{{"upsert", {status("three")}}, {"remove", {"one"}}}, token_a).status == 200);

    // The application's own store: private, bounded, and it survives a restart.
    EXPECT(call("PUT", alpha + "/storage/prefs", json{{"theme", "plain"}, {"n", 3}}, token_a).status == 200);
    EXPECT(call("GET", alpha + "/storage/prefs", none, token_a).data().at("value") == (json{{"theme", "plain"}, {"n", 3}}));
    EXPECT(has(call("GET", alpha + "/storage", none, token_a).data().at("keys"), "prefs"));
    EXPECT(call("GET", alpha + "/storage/prefs", none, token_b).status == 401, "another application cannot read it");
    EXPECT(call("GET", gamma + "/storage", none, token_c).code() == "CAPABILITY_NOT_GRANTED");
    EXPECT(call("GET", alpha + "/storage/absent", none, token_a).code() == "KEY_NOT_FOUND");
    EXPECT(call("PUT", alpha + "/storage/big", json{{"x", std::string(300000, 'y')}}, token_a).code() == "STORAGE_FULL");
    EXPECT(call("PUT", alpha + "/storage/gone", json(1), token_a).status == 200);
    EXPECT(call("DELETE", alpha + "/storage/gone", none, token_a).status == 200);

    // Messages arrive as events; only for those who asked to use them.
    EXPECT(call("POST", alpha + "/messages", json{{"to", "org.test.beta"}, {"type", "hello"}, {"data", {{"n", 1}}}}, token_a).status == 202);
    json message;
    for (const auto& e : json(call("GET", beta + "/events", none, token_b).data().at("items"))) {
        if (e.at("type") == "message") message = e;
    }
    EXPECT(message.at("data") == (json{{"from", "org.test.alpha"}, {"type", "hello"}, {"data", {{"n", 1}}}}), message);
    EXPECT(call("POST", alpha + "/messages", json{{"to", "org.test.gamma"}, {"type", "hello"}}, token_a).code() == "RECIPIENT_NOT_LISTENING");
    EXPECT(call("POST", gamma + "/messages", json{{"to", "org.test.beta"}, {"type", "hello"}}, token_c).code() == "CAPABILITY_NOT_GRANTED");
    EXPECT(call("POST", alpha + "/messages", json{{"to", "org.test.beta"}, {"type", "x"}, {"data", std::string(20000, 'z')}}, token_a).code() == "MESSAGE_TOO_LARGE");

    // Subscriptions and timers, on a real run.
    EXPECT(call("PUT", beta + "/subscriptions", json{{"topics", {"nonsense"}}}, token_b).code() == "INVALID_TOPICS");
    EXPECT(call("PUT", gamma + "/subscriptions", json{{"topics", {"news"}}}, token_c).code() == "CAPABILITY_NOT_GRANTED");
    EXPECT(call("PUT", beta + "/subscriptions", json{{"topics", {"lifecycle", "world", "news"}}}, token_b).data().at("topics") == json::array({"lifecycle", "news", "world"}));
    EXPECT(call("PUT", beta + "/timers/early", json{{"at_s", -1}}, token_b).code() == "INVALID_TIMER");
    EXPECT(call("PUT", beta + "/timers/early", json{{"at_s", 60}, {"data", {{"why", "test"}}}}, token_b).status == 200);
    EXPECT(call("PUT", beta + "/timers/every", json{{"at_s", 120}, {"every_s", 120}}, token_b).status == 200);
    EXPECT(call("PUT", beta + "/timers/later", json{{"at_s", 80000}}, token_b).status == 200);
    EXPECT(call("DELETE", beta + "/timers/later", none, token_b).status == 200);
    EXPECT(call("DELETE", beta + "/timers/later", none, token_b).code() == "TIMER_NOT_FOUND");
    const auto timers = call("GET", beta + "/timers", none, token_b).data().at("items");
    EXPECT(timers.size() == 2 && timers[0].at("id") == "early" && timers[1].at("id") == "every", timers);
    // Followed from before the run, so that its first news and its start are seen.
    call("GET", beta + "/events", none, token_b);
    const auto started = server->op("POST", "/api/v1/playback/start", json{{"seed", "10775"}, {"playback_duration_seconds", 600}, {"map", {{"osm_file", "data/fixtures/real_network.osm.xml"}}}});
    EXPECT(started.status == 202, started);
    json events = json::array();
    std::set<std::string> kinds;
    const auto every_count = [&] {
        return std::count_if(events.begin(), events.end(), [](const json& e) { return e.at("type") == "timer" && e.at("data").at("id") == "every"; });
    };
    std::string since = "0";
    for (const double end = now() + 40; now() < end;) {
        const auto page = call("GET", beta + "/events?since=" + since, none, token_b).data();
        for (const auto& e : page.at("items")) {
            events.push_back(e);
            kinds.insert(e.at("type"));
        }
        since = page.at("sequence").dump();
        if (kinds.contains("timer") && kinds.contains("news") && kinds.contains("lifecycle.changed") && every_count() >= 2) break;
        delay(0.2);
    }
    EXPECT(kinds.contains("timer") && kinds.contains("news") && kinds.contains("lifecycle.changed"), json(kinds));
    json early = json::array(), every = json::array();
    for (const auto& e : events) {
        if (e.at("type") != "timer") continue;
        EXPECT(e.at("data").at("virtual_s") >= e.at("data").at("at_s"), e);
        if (e.at("data").at("id") == "early") early.push_back(e);
        if (e.at("data").at("id") == "every") every.push_back(e.at("data").at("at_s"));
    }
    EXPECT(early.size() == 1 && early[0].at("data").at("data") == (json{{"why", "test"}}), early);
    EXPECT(every.size() >= 2 && every[0] == 120 && every[1] == 240, every);
    // Only what was asked for.
    const std::string token_d = call("POST", BASE, manifest("org.test.delta", {"sim.read"})).data().at("token");
    EXPECT(call("PUT", BASE + "/org.test.delta/subscriptions", json{{"topics", {"news.incident"}}}, token_d).status == 200);
    delay(0.5);
    for (const auto& e : json(call("GET", BASE + "/org.test.delta/events", none, token_d).data().at("items"))) {
        EXPECT(e.at("type") != "news" || e.at("data").at("category") == "incident", e);
    }

    // The engine, through Fabric: authorized, and the older paths still answer and say so.
    const std::string engine = "/api/v1/fabric/engine";
    const Headers observer = {{"X-DSTNS-Host", "observer"}};
    EXPECT(call("GET", engine + "/status").status == 200);
    EXPECT(call("POST", engine + "/pause", json::object()).code() == "AUTHORIZATION_REQUIRED");
    EXPECT(call("POST", engine + "/pause", json::object(), token_b).code() == "AUTHORIZATION_REQUIRED", "an application acts through its own route");
    EXPECT(call("POST", engine + "/start", json{{"seed", "1"}}, "", observer).code() == "CLI_START_REQUIRED");
    EXPECT(server->op("POST", engine + "/pause", json::object()).status == 200);
    EXPECT(call("POST", engine + "/play", json::object(), "", observer).status == 200);
    EXPECT(server->op("PUT", engine + "/tick-rate", json{{"tick_rate", 2}}).status == 200);
    const auto legacy = call("GET", "/api/v1/playback/status");
    EXPECT(legacy.status == 200 && legacy.header("Deprecation") == "true" && contains(legacy.header("Warning"), "Fabric API"), legacy);
    EXPECT(legacy.body.at("legacy").at("use") == engine + "/status" && contains(legacy.body.at("legacy").at("message").get<std::string>(), "legacy API"), legacy);
    const auto current = call("GET", engine + "/status");
    EXPECT(!current.body.contains("legacy") && current.header("Deprecation").empty(), current);
    const auto pause = call("POST", "/api/v1/playback/pause", json::object());
    EXPECT(pause.status == 200 && pause.body.at("legacy").at("use") == engine + "/pause", pause);

    security_checks(*server, token_a);

    // Health, for the application itself or for a supervisor.
    const auto health = call("GET", beta + "/health", none, token_b).data();
    EXPECT(health.at("requests") > 3 && health.at("timers") == 2 && health.at("messages").at("received") == 1 && health.at("storage").at("keys") == 0, health);
    EXPECT(call("GET", alpha + "/health", none, "", server->host).data().at("messages").at("sent") == 1);
    EXPECT(call("GET", alpha + "/health").status == 401);
    server->stop();
    server = std::make_unique<Server>(tmp.path);
    // It returns as itself, with its token, and finds what it left.
    const auto returned = call("POST", BASE, alpha_manifest, token_a).status;
    EXPECT(returned == 200 || returned == 201, returned);
    EXPECT(call("GET", alpha + "/storage/prefs", none, token_a).data().at("value").at("n") == 3, "the store survives a restart");
    // A store that has been changed behind the server's back is not trusted.
    server->stop();
    auto sealed = json::parse(read(tmp / "fabric-apps.json"));
    sealed["apps"]["org.test.alpha"]["manifest"]["capabilities"].push_back("control.world");
    sealed["apps"]["org.test.alpha"]["granted"].push_back("control.world");
    write(tmp / "fabric-apps.json", sealed.dump());
    server = std::make_unique<Server>(tmp.path);
    EXPECT(call("GET", alpha + "/health", none, "", server->host).status == 404, "what it said is not believed");
    EXPECT(call("GET", "/api/v1/fabric/security", none, "", server->host).data().at("store").at("rejected") == true);
    EXPECT(fs::exists(tmp / "fabric-apps.json.rejected"));
    std::cout << "fabric platform ok\n";
}
