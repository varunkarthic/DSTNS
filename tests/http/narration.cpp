// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Realistic News over HTTP, against a stand-in Chat Completions server.
//
// The stand-in plays the part `fm serve` plays on a Mac: it receives the facts of each narratable news item and answers
// with an item. Checks that the server sends facts and context rather than internal identifiers, that narrations reach
// a client that asks for them (?narration=realistic, directly and through the since_narration cursor) and no other,
// that the narrator reports itself, and that --narrator off leaves the feed exactly as it was.
#include "harness.hpp"

#include <memory>

using namespace check;

namespace {

struct Day {
    std::unique_ptr<Server> server;
    json news;
};

// A server with these narrator settings, through a whole fixture day so that every incident fires and clears.
Day run_day(const TempDir& tmp, const std::vector<std::string>& narrator) {
    auto server = std::make_unique<Server>(tmp / ("logs-" + std::to_string(free_port())), narrator);
    const json payload = {{"seed", "4242"}, {"playback_duration_seconds", 3600}, {"fixture", {{"grid_width", 12}, {"grid_height", 10}}}, {"modules", {{"buildings", false}}}};
    const auto prepared = server->op("POST", "/api/v1/playback/prepare", payload, 5).status;
    EXPECT(prepared == 200 || prepared == 202, prepared);
    until([&] { return server->op("GET", "/api/v1/playback/status").data().at("lifecycle") == "READY"; }, 20, "the world");
    for (int hour = 0; hour < 24; ++hour) EXPECT(server->op("POST", "/api/v1/playback/step", json{{"seconds", 3600}}, 5).status == 200);
    const auto news = server->op("GET", "/api/v1/news?since_news_id=0&limit=500");
    EXPECT(news.status == 200, news);
    return {std::move(server), news.data()};
}

bool incident(const json& item) { return item.at("template_id").get<std::string>().starts_with("INCIDENT_"); }

} // namespace

int main() {
    std::mutex lock;
    std::vector<std::string> facts;
    Upstream stand_in;
    const auto send = [](httplib::Response& res, const json& body) { res.set_content(body.dump(), "application/json"); };
    stand_in.http.Get(".*", [&](const httplib::Request&, httplib::Response& res) { send(res, {{"object", "list"}, {"data", {{{"id", "stand-in"}}}}}); });
    stand_in.http.Post(".*", [&](const httplib::Request& req, httplib::Response& res) {
        const auto said = json::parse(req.body).at("messages").back().at("content").get<std::string>();
        {
            std::lock_guard guard(lock);
            facts.push_back(said);
        }
        const auto text = contains(said, "cleared") ? "The incident has cleared and traffic is moving normally again." : "Drivers are reporting slow traffic in the area this hour.";
        send(res, {{"choices", {{{"index", 0}, {"message", {{"role", "assistant"}, {"content", text}}}}}}});
    });
    stand_in.start();
    TempDir tmp("dstns-narration-http-");

    auto [narrated_server, feed] = run_day(tmp, {"--narrator", stand_in.url(), "--narrator-cache", "none"});
    const auto& server = *narrated_server;
    EXPECT(std::any_of(feed.at("items").begin(), feed.at("items").end(), incident), "the fixture day has incidents");
    // Narrations were prefetched at prepare; any written after an item was served arrive through the cursor.
    feed = *until([&]() -> std::optional<json> {
        auto data = server.op("GET", "/api/v1/news?since_news_id=0&limit=500&narration=realistic").data();
        for (const auto& item : data.at("items")) {
            if (incident(item) && !item.contains("narrative")) return std::nullopt;
        }
        return data;
    }, 20, "the narrations");
    EXPECT(feed.contains("narration_sequence") && feed.at("narration_sequence") >= 1, feed);
    const auto last = std::to_string(feed.at("items").back().at("news_id").get<long long>());
    const auto cursor = server.op("GET", "/api/v1/news?since_news_id=" + last + "&since_narration=0&narration=realistic").data();
    EXPECT(std::any_of(cursor.at("narrated").begin(), cursor.at("narrated").end(), [](const json& n) { return !n.at("narrative").get<std::string>().empty(); }),
           "the cursor lists narrations of items already served");
    const auto caught_up = server.op("GET", "/api/v1/news?since_news_id=" + last + "&since_narration=" + feed.at("narration_sequence").dump() + "&narration=realistic").data();
    EXPECT(caught_up.at("narrated").empty(), "a client that is up to date is sent nothing again");
    {
        std::lock_guard guard(lock);
        EXPECT(!facts.empty());
        for (const auto& said : facts) EXPECT(!contains(said, "Edge #") && contains(said, "Event:") && contains(said, "Time:"), "the model sees facts and context, not identifiers", said);
    }
    const auto plain_with_narrator = server.op("GET", "/api/v1/news?since_news_id=0&limit=500").data();
    for (const auto& item : plain_with_narrator.at("items")) EXPECT(!item.contains("narrative"), "narrations are served only to a client that asks for them");
    EXPECT(!plain_with_narrator.contains("narrated"));
    for (const auto& item : json(server.op("GET", "/api/v1/view/snapshot").data().at("event_stack"))) EXPECT(!item.contains("narrative"), "nor are they in the snapshot");
    const auto narrator = server.op("GET", "/api/v1/system/narrator").data();
    EXPECT(narrator.at("enabled") == true && narrator.at("backend").at("endpoint") == stand_in.url() && narrator.at("completed") >= 1, narrator);

    auto [plain_server, plain] = run_day(tmp, {"--narrator", "off"});
    for (const auto& item : plain.at("items")) EXPECT(!item.contains("narrative"), "no narrator, no narratives");
    EXPECT(!plain.contains("narration_sequence") && !plain.contains("narrated"), "the feed keeps its old shape");
    EXPECT(plain.at("items").size() == feed.at("items").size(), "narration never changes the core text");
    for (std::size_t i = 0; i < plain.at("items").size(); ++i) {
        const auto& a = plain["items"][i];
        const auto& b = feed["items"][i];
        EXPECT(a.at("template_id") == b.at("template_id") && a.at("message") == b.at("message"), "narration never changes the core text", a, b);
    }
    EXPECT(plain_server->op("GET", "/api/v1/system/narrator").data().at("enabled") == false);
    std::cout << "narration smoke: ok\n";
}
