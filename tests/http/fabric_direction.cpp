// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// An application directing the view, against a real server and a real world.
//
// Everything asked for needs a person's grant, is checked against closed lists and ranges, is limited, is on the
// record, and is gone when the application is. None of it is ever saved.
#include "harness.hpp"

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

} // namespace

int main() {
    TempDir tmp;
    auto server = std::make_unique<Server>(tmp.path);
    const auto& s = *server;
    const auto call = [&](const std::string& method, const std::string& route, std::optional<json> data = none, const std::string& token = "", Headers headers = {}) {
        return server->call(method, route, data, token, headers);
    };
    const auto started = s.op("POST", "/api/v1/playback/start", json{{"seed", "10775"}, {"playback_duration_seconds", 600}, {"map", {{"osm_file", "data/fixtures/real_network.osm.xml"}}}});
    EXPECT(started.status >= 200 && started.status <= 202, started);
    until([&] { return call("GET", "/api/v1/playback/status").data().at("lifecycle") == "RUNNING"; }, 40, "the run");

    const auto made = call("POST", BASE, manifest("org.test.director", {"ui.camera", "ui.layers", "ui.overlays"}));
    EXPECT(made.status == 201, made);
    const std::string token = made.data().at("token");
    const auto app = BASE + "/org.test.director";

    // Only a person gives this.
    for (const auto& [route, method, sent] : std::vector<std::tuple<std::string, std::string, json>>{{app + "/view", "POST", {{"action", "fit"}}}, {app + "/presentation", "PUT", {{"layers", {{"roads", false}}}}}}) {
        const auto refused = call(method, route, sent, token);
        EXPECT(refused.status == 403 && refused.code() == "CAPABILITY_NOT_GRANTED", refused);
    }
    const auto discovery = call("GET", "/api/v1/fabric/capabilities").data();
    const auto person = discovery.at("capabilities").at("needs_a_person");
    for (const char* capability : {"ui.camera", "ui.layers"}) EXPECT(std::find(person.begin(), person.end(), capability) != person.end(), capability);
    EXPECT(discovery.at("path_styles") == json::array({"solid", "dashed", "dotted", "flow"}));

    // An application that did not ask can't be given it.
    EXPECT(call("POST", BASE, manifest("org.test.other")).status == 201);
    auto refused = call("PUT", BASE + "/org.test.other/grants", json{{"capabilities", {"ui.camera"}}}, "", s.host);
    EXPECT(refused.status == 400 && refused.code() == "CAPABILITY_NOT_REQUESTED", refused);
    // Nor can it be given by an application.
    EXPECT(call("PUT", app + "/grants", json{{"capabilities", {"ui.camera", "ui.layers"}}}, token).status == 403);
    const auto grant_all = [&] { return call("PUT", app + "/grants", json{{"capabilities", {"ui.camera", "ui.layers", "ui.overlays"}}}, "", s.host); };
    EXPECT(grant_all().status == 200);

    // Without its token, nothing.
    EXPECT(call("POST", app + "/view", json{{"action", "fit"}}).status == 401);

    // Past the rate limit.
    const auto settled = [&](const std::string& method, const std::string& route, const json& sent) {
        for (int i = 0; i < 40; ++i) {
            auto result = call(method, route, sent, token);
            if (result.status != 429) return result;
            delay(0.25);
        }
        fail("never allowed", __FILE__, __LINE__);
    };
    const auto state = [&](const std::string& query = "") { return call("GET", "/api/v1/fabric/state" + query).data(); };

    // Moving the map: closed lists and ranges, and only what is known goes on.
    for (const json& wrong : {json::object(), json{{"action", "explode"}}, json{{"action", 1}}, json{{"action", "focus"}, {"x_m", 1}}, json{{"action", "focus"}, {"x_m", "1"}, {"y_m", 2}},
                              json{{"action", "focus"}, {"x_m", 1e12}, {"y_m", 0}}, json{{"action", "focus"}, {"x_m", 0}, {"y_m", 0}, {"span_m", 1}}, json{{"action", "zoom"}, {"factor", 5}},
                              json{{"action", "zoom"}, {"factor", 0.1}}, json{{"action", "zoom"}}, json{{"action", "node"}, {"node", -1}}, json{{"action", "edge"}, {"edge", "1"}},
                              json{{"action", "bounds"}, {"min_x_m", 5}, {"min_y_m", 0}, {"max_x_m", 5}, {"max_y_m", 9}}, json::array()}) {
        refused = settled("POST", app + "/view", wrong);
        EXPECT(refused.status == 400 && refused.code() == "INVALID_VIEW", wrong, refused);
    }
    refused = settled("POST", app + "/view", {{"action", "node"}, {"node", 99999999}});
    EXPECT(refused.status == 422 && refused.code() == "NOT_ON_NETWORK", refused);

    auto before = state().at("view_sequence").dump();
    const auto asked = settled("POST", app + "/view", {{"action", "focus"}, {"x_m", 10}, {"y_m", 20}, {"span_m", 400}, {"duration_ms", 1}, {"script", "x"}});
    EXPECT(asked.status == 202, asked);
    const auto number = asked.data().at("request");
    auto requests = state("?view_since=" + before).at("view_requests");
    EXPECT(requests.size() == 1 && requests[0].at("request") == number, requests);
    EXPECT(requests[0].at("view") == (json{{"action", "focus"}, {"x_m", 10}, {"y_m", 20}, {"span_m", 400}}), "nothing else goes through", requests);
    EXPECT(requests[0].at("app") == "org.test.director");
    EXPECT(state("?view_since=" + number.dump()).at("view_requests").empty());
    // A request is for now. An observer coming back later isn't thrown around by it.
    delay(5.2);
    EXPECT(state("?view_since=" + before).at("view_requests").empty(), "stale requests are dropped");

    // The limit.
    std::vector<int> statuses;
    for (int i = 0; i < 12; ++i) statuses.push_back(call("POST", app + "/view", json{{"action", "fit"}}, token).status);
    EXPECT(std::count(statuses.begin(), statuses.end(), 429) > 0 && std::count(statuses.begin(), statuses.end(), 202) >= 4, json(statuses));

    // What became of it: only the observer says, and the application hears.
    EXPECT(call("POST", app + "/view/outcome", json{{"request", 1}, {"outcome", "applied"}}, token).status == 403);
    EXPECT(call("POST", app + "/view/outcome", json{{"request", 1}, {"outcome", "maybe"}}, "", s.host).status == 400);
    EXPECT(call("POST", app + "/view/outcome", json{{"request", number}, {"outcome", "declined"}, {"reason", "person_moved_the_map"}}, "", s.host).status == 200);
    bool heard = false;
    for (const auto& e : json(call("GET", app + "/events", none, token).data().at("items"))) {
        heard = heard || (e.at("type") == "view.declined" && e.at("data").at("request") == number && e.at("data").at("reason") == "person_moved_the_map");
    }
    EXPECT(heard, number, call("GET", app + "/events", none, token));

    // Holding layers: a closed list, and strict values.
    json many = json::object();
    for (int i = 0; i < 65; ++i) many["k" + std::to_string(i)] = true;
    for (const json& wrong : {json::array(), json{{"layers", {{"nonsense", true}}}}, json{{"layers", {{"roads", 1}}}}, json{{"layers", json::array()}}, json{{"settings", json::object()}},
                              json{{"places", {{"BAD KIND", true}}}}, json{{"places", {{"school", "no"}}}}, json{{"places", many}}}) {
        refused = settled("PUT", app + "/presentation", wrong);
        EXPECT(refused.status == 400 && refused.code() == "INVALID_PRESENTATION", wrong, refused);
    }
    EXPECT(settled("PUT", app + "/presentation", {{"layers", {{"weather", false}}}, {"places", {{"school", false}}}}).status == 200);
    auto shown = state().at("presentation");
    EXPECT(shown.size() == 1 && shown[0].at("app") == "org.test.director" && shown[0].at("layers") == (json{{"weather", false}}) && shown[0].at("places") == (json{{"school", false}}), shown);
    const auto first = shown[0].at("revision");
    EXPECT(settled("PUT", app + "/presentation", {{"layers", {{"vehicles", true}}}}).status == 200);
    shown = state().at("presentation");
    EXPECT(shown[0].at("layers") == (json{{"vehicles", true}}) && shown[0].at("places").empty(), "it replaces what was held");
    EXPECT(shown[0].at("revision") > first, "and a person can tell it has asked again");
    // Reported even when nothing else has changed, or a held layer would outlast its application.
    EXPECT(state("?since=" + state().at("revision").dump()).at("presentation") == shown);

    // It lets go, and it is let go of.
    EXPECT(call("DELETE", app + "/presentation", none, token).status == 200);
    EXPECT(state().at("presentation").empty());
    EXPECT(settled("PUT", app + "/presentation", {{"layers", {{"roads", false}}}}).status == 200);
    EXPECT(call("POST", app + "/suspend", none, "", s.host).status == 200);
    EXPECT(state().at("presentation").empty(), "suspended");
    refused = call("POST", app + "/view", json{{"action", "fit"}}, token);
    EXPECT(refused.status == 409 && refused.code() == "APP_NOT_ACTIVE", refused);
    EXPECT(call("POST", app + "/resume", none, "", s.host).status == 200);
    EXPECT(state().at("presentation").empty(), "resuming does not bring it back unasked");

    EXPECT(settled("PUT", app + "/presentation", {{"layers", {{"roads", false}}}}).status == 200);
    EXPECT(call("PUT", app + "/grants", json{{"capabilities", {"ui.camera", "ui.overlays"}}}, "", s.host).status == 200);
    EXPECT(state().at("presentation").empty(), "revoked");
    EXPECT(call("PUT", app + "/presentation", json{{"layers", {{"roads", false}}}}, token).status == 403);
    EXPECT(grant_all().status == 200);
    EXPECT(state().at("presentation").empty(), "granting again does not bring it back either");

    // Asked for by a request nobody may see any more, once the grant has gone.
    before = state().at("view_sequence").dump();
    EXPECT(settled("POST", app + "/view", {{"action", "fit"}}).status == 202);
    EXPECT(call("PUT", app + "/grants", json{{"capabilities", {"ui.layers", "ui.overlays"}}}, "", s.host).status == 200);
    EXPECT(state("?view_since=" + before).at("view_requests").empty(), "revoked while it waited");
    EXPECT(grant_all().status == 200);

    // Its own marks can choose how they look, within closed lists.
    auto topology = call("GET", "/api/v1/view/topology").body;
    if (topology.contains("data")) topology = topology["data"];
    const auto road = topology.at("edges")[0];
    for (const json& wrong : {json{{"color", "red"}}, json{{"color", "#12345"}}, json{{"color", "#12345g"}}, json{{"color", 5}}, json{{"style", "wavy"}}, json{{"glow", "yes"}}}) {
        json feature = {{"type", "route"}, {"nodes", {road.at("from"), road.at("to")}}};
        feature.update(wrong);
        refused = call("PUT", app + "/ui/line", json{{"id", "line"}, {"slot", "overlay"}, {"features", {feature}}}, token);
        EXPECT(refused.status == 400 && refused.code() == "INVALID_ELEMENT", wrong, refused);
    }
    EXPECT(call("PUT", app + "/ui/dot", json{{"id", "dot"}, {"slot", "overlay"}, {"features", {{{"type", "point"}, {"x_m", 0}, {"y_m", 0}, {"color", "url(x)"}}}}}, token).status == 400,
           "a colour is checked on every kind of mark");
    const auto allowed = call("PUT", app + "/ui/dot", json{{"id", "dot"}, {"slot", "overlay"}, {"features", {{{"type", "point"}, {"x_m", 0}, {"y_m", 0}, {"color", "auto"}},
                                                                                                          {{"type", "circle"}, {"x_m", 1}, {"y_m", 1}, {"color", "#37D7FF"}}}}}, token);
    EXPECT(allowed.status == 200, allowed);

    // All of it is on the record, refusals too, and the record holds together.
    std::set<std::pair<std::string, std::string>> actions;
    for (const auto& e : json(call("GET", "/api/v1/fabric/audit?limit=2000").data().at("items"))) {
        if (e.at("app_id") != "org.test.director") continue;
        const auto outcome = e.at("outcome").get<std::string>();
        actions.insert({e.at("action").get<std::string>(), outcome.substr(0, outcome.find(':'))});
    }
    for (const auto& wanted : std::vector<std::pair<std::string, std::string>>{{"view", "asked"}, {"view", "refused"}, {"presentation", "held"}, {"presentation", "released"}, {"presentation", "refused"}}) {
        EXPECT(actions.contains(wanted), wanted.first + " " + wanted.second);
    }
    EXPECT(call("GET", "/api/v1/fabric/audit/verify", none, "", s.host).data().at("intact") == true);

    // None of it is ever saved.
    EXPECT(settled("PUT", app + "/presentation", {{"layers", {{"roads", false}}}}).status == 200);
    server->stop();
    const auto saved = read(tmp / "fabric-apps.json");
    EXPECT(!contains(saved, "presentation") && !contains(saved, "view_requests"), "held apart, and never kept");
    EXPECT(!json::parse(saved, nullptr, false).is_discarded());
    server = std::make_unique<Server>(tmp.path);
    const auto after = server->call("GET", "/api/v1/fabric/state").data();
    EXPECT(after.at("presentation").empty() && after.at("view_requests").empty());
    std::cout << "fabric direction ok\n";
}
