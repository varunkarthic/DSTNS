// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Realistic News: the fact builder, the checks on what a model writes, the
// narrator's queue and caches, the API serving narrations only on request, and
// the guarantee that matters most - a narrator changes what the operator reads
// and nothing about the run.
//
// The model is a scripted backend, so every path is exercised without a
// language model installed.
#include "dstns/engine.hpp"
#include "dstns/logging.hpp"
#include "dstns/narrator.hpp"
#include "dstns/scenario.hpp"
#include "dstns/utf8.hpp"

#include <atomic>
#include <filesystem>
#include <functional>
#include <iostream>
#include <string>
#include <unistd.h>

using namespace dstns;

int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "  FAIL: " << message << '\n';
        ++failures;
    }
}

// Answers with whatever the script returns, counting calls.
class ScriptedBackend final : public NarrationBackend {
public:
    explicit ScriptedBackend(std::function<std::optional<std::string>(const std::string&)> script) : script_(std::move(script)) {}
    bool ready() override { return true; }
    std::optional<std::string> complete(const std::string&, const std::string& facts) override {
        ++calls;
        last_facts = facts;
        return script_(facts);
    }
    [[nodiscard]] nlohmann::json describe() const override { return {{"kind", "scripted"}, {"model", "scripted"}}; }
    std::atomic<int> calls{0};
    std::string last_facts;
private:
    std::function<std::optional<std::string>(const std::string&)> script_;
};

std::filesystem::path temp_path(const std::string& name) {
    return std::filesystem::temp_directory_path() / ("dstns-narrator-test-" + std::to_string(::getpid()) + "-" + name);
}

ScenarioConfig small_world() {
    ScenarioConfig cfg;
    cfg.grid_width = 12;
    cfg.grid_height = 10;
    cfg.min_incidents = 6;
    cfg.playback_duration_s = 600;
    return cfg;
}

const auto kSeed = Seed128::parse("0x0000000000000000000000000000BEEF");

int main() {
    // ---- What the model may write -----------------------------------------
    {
        const std::string facts = "Event: an incident has just happened\nKind: collision\nRoad: Uhuru Street\n"
                                  "Area: the central district\nTime: 08:10, the morning rush hour\n"
                                  "Traffic speed: 35% of normal\nExpected to clear: 14:20\n";
        auto ok = accept_narration("A two-car shunt on Uhuru Street has traffic crawling at about 35% of normal through the "
                                   "central district this morning. Recovery crews are on their way, so drivers may want to "
                                   "avoid the area; it should be clear by 14:20.", facts);
        check(ok.has_value(), "plausible colour and advice are what Realistic News is for");
        check(!accept_narration("A collision on Uhuru Street has slowed traffic to 40% of normal this morning.", facts).has_value(),
              "a number that is not among the facts is refused");
        check(!accept_narration("A collision on Uhuru Street should clear by 15:30, police say.", facts).has_value(),
              "a time that is not among the facts is refused");
        check(!accept_narration("A collision on Uhuru Street has left one driver dead this morning.", facts).has_value(),
              "deaths the facts do not mention are refused");
        check(!accept_narration("Event: an incident has just happened. Road: Uhuru Street.", facts).has_value(),
              "facts echoed back as labels are refused");
        check(!accept_narration("As an assistant, I can tell you Uhuru Street is slow.", facts).has_value(),
              "the model speaking as itself is refused");
        check(!accept_narration("Slow.", facts).has_value(), "too short is refused");
        check(!accept_narration(std::string(600, 'a'), facts).has_value(), "too long is refused");
        const auto cleaned = accept_narration("  \"**A collision** on Uhuru Street\n has slowed traffic\"  ", facts);
        check(cleaned && *cleaned == "A collision on Uhuru Street has slowed traffic.", "quotes, markdown and newlines are cleaned and a full stop added");
    }

    // ---- What the model is given -------------------------------------------
    {
        ScenarioCompiler compiler;
        const auto scenario = compiler.compile(kSeed, small_world());
        const NarrationContext context(scenario);
        const auto& inc = scenario.incidents.front();
        const nlohmann::json data{{"incident_id", inc.id}, {"type", to_string(inc.type)}, {"edge_id", inc.edge.value},
                                  {"node_id", inc.node.value}, {"speed_multiplier", 0.35}, {"capacity_multiplier", 0.4},
                                  {"closed", false}, {"end_virtual_s", 51600}};
        const auto message = "[10:00:00] " + inc.description + " on Edge #" + std::to_string(inc.edge.value) + " near Node #1. (MID SEVERITY)";
        const auto request = narration_request(context, "INCIDENT_ACTIVATED", message, data, inc.start_virtual_s);
        check(request.has_value(), "an incident activation is narrated");
        if (request) {
            check(request->facts.find("Traffic speed: 35% of normal") != std::string::npos, "speed is given as a percentage");
            check(request->facts.find("Expected to clear: 14:20") != std::string::npos, "the clearing time is given as HH:MM");
            check(request->facts.find("Edge #") == std::string::npos && request->facts.find("SEVERITY") == std::string::npos,
                  "internal identifiers stay out of the facts");
            check(request->facts.find("Area: the ") != std::string::npos, "the district is named");
            check(request->facts.find("Time: ") != std::string::npos && request->facts.find("Day: a weekday") != std::string::npos,
                  "the hour and the day are given");
            const auto again = narration_request(context, "INCIDENT_ACTIVATED", message, data, inc.start_virtual_s);
            check(again && again->key == request->key, "identical facts share a key");
            const auto later = narration_request(context, "INCIDENT_ACTIVATED", message, data, inc.start_virtual_s + 7200);
            check(later && later->key != request->key, "the hour is part of the story, so a different hour is a different item");
        }
        check(!narration_request(context, "SIGNALS_ONLINE", "x", nlohmann::json::object(), 0).has_value(),
              "system news is not narrated");
        // A place's demand is narrated at its peak only.
        std::size_t place = scenario.features.size();
        for (std::size_t i = 0; i < scenario.features.size(); ++i)
            if (scenario.features[i].demand_type) { place = i; break; }
        if (place < scenario.features.size()) {
            const nlohmann::json demand{{"feature_id", scenario.features[place].id}, {"multiplier", 1.6}};
            const auto peak = narration_request(context, "DEMAND_CHANGED", "School arrival / departure peak · Riverside", demand, 30000);
            check(peak && peak->facts.find("school run") != std::string::npos, "a school's peak is told as the school run");
            check(!narration_request(context, "DEMAND_CHANGED", "School arrival / departure · Riverside", demand, 29000),
                  "the steps either side of a peak are not narrated");
        }
        // Earlier incidents in the same district are part of the story.
        if (scenario.incidents.size() >= 2) {
            const auto& later = scenario.incidents.back();
            const auto story = context.earlier_incidents(later.edge.value, later.start_virtual_s, 5);
            for (const auto& item : story) check(item.find(" at ") != std::string::npos, "an earlier incident says when it happened");
        }
        const auto ended = narration_request(context, "DWS_RAIN_ENDED", "[05:00:56] Rain storm cleared at Node 3; network returning", nlohmann::json{}, 0);
        check(ended && ended->facts.find("rain has cleared") != std::string::npos, "rain ending finds its node in the core's text");
    }

    // ---- The narrator: queue, cache, refusals, persistence -------------------
    {
        const auto cache = temp_path("cache.db");
        std::filesystem::remove(cache);
        NarrationRequest a{"key-a", "INCIDENT_RESOLVED", "Event: an incident has cleared\nRoad: Uhuru Street\n", 10};
        NarrationRequest b{"key-b", "INCIDENT_RESOLVED", "Event: an incident has cleared\nRoad: Bad Road\n", 20};
        {
            auto backend = std::make_unique<ScriptedBackend>([](const std::string& facts) -> std::optional<std::string> {
                if (facts.find("Bad Road") != std::string::npos) return std::string("One driver died on Bad Road this morning.");
                return std::string("The incident on Uhuru Street has cleared.");
            });
            auto* script = backend.get();
            Narrator narrator(std::move(backend), {cache, 64, 16, 1});
            narrator.request(a, false);
            narrator.request(b, true);
            check(narrator.wait_idle(std::chrono::seconds(5)), "the queue drains");
            const auto told = narrator.lookup("key-a");
            check(told && told->text == "The incident on Uhuru Street has cleared." && told->sequence > 0, "a kept narration is served with its sequence");
            check(!narrator.lookup("key-b").has_value(), "a refused narration is not served");
            narrator.request(b, true);
            narrator.request(a, true);
            narrator.wait_idle(std::chrono::seconds(5));
            check(script->calls == 2, "neither a refused nor a kept narration is asked for twice");
            const auto status = narrator.status();
            check(status["completed"] == 1 && status["refused"] == 1 && status["cache_hits"] == 1, "status counts completions, refusals and hits");
        }
        {
            // A restart: the kept narration comes back from disk without asking.
            auto backend = std::make_unique<ScriptedBackend>([](const std::string&) { return std::optional<std::string>{}; });
            auto* script = backend.get();
            Narrator narrator(std::move(backend), {cache, 64, 16, 1});
            check(narrator.lookup("key-a").has_value(), "narrations persist across restarts");
            narrator.request(a, true);
            narrator.wait_idle(std::chrono::seconds(2));
            check(script->calls == 0, "a persisted narration is not regenerated");
        }
        std::filesystem::remove(cache);
    }
    {
        // A model that never answers: requests fail, the narrator backs off.
        auto backend = std::make_unique<ScriptedBackend>([](const std::string&) { return std::optional<std::string>{}; });
        Narrator narrator(std::move(backend), {{}, 64, 16, 1});
        for (int i = 0; i < 3; ++i) narrator.request({"k" + std::to_string(i), "INCIDENT_RESOLVED", "Event: x\n", 0}, true);
        narrator.wait_idle(std::chrono::seconds(5));
        const auto status = narrator.status();
        check(status["failed"] == 3 && status["state"] == "backoff", "three failures in a row back off");
    }
    {
        // Bounded: prefetch beyond the limit is shed, furthest-off first.
        std::atomic<bool> release{false};
        auto backend = std::make_unique<ScriptedBackend>([&](const std::string&) {
            while (!release) std::this_thread::sleep_for(std::chrono::milliseconds(1));
            return std::optional<std::string>("Conditions have changed on the network.");
        });
        Narrator narrator(std::move(backend), {{}, 64, 4, 1});
        for (std::uint32_t i = 0; i < 10; ++i) narrator.request({"p" + std::to_string(i), "INCIDENT_RESOLVED", "Event: x\n", i}, false);
        check(narrator.status()["dropped"].get<int>() >= 5, "a full queue sheds work instead of growing");
        release = true;
        narrator.wait_idle(std::chrono::seconds(5));
        check(narrator.lookup("p0").has_value() || narrator.lookup("p1").has_value(), "the earliest items survive the shedding");
        check(!narrator.lookup("p9").has_value(), "the furthest-off item is the one shed");
    }

    // ---- In the engine: narrations appear, and nothing else changes ----------
    {
        auto run = [](std::shared_ptr<Narrator> narrator, nlohmann::json& snapshot, nlohmann::json& news) {
            const auto dir = temp_path(narrator ? "with" : "without");
            std::filesystem::remove_all(dir);
            {
                RuntimeLogger logger(dir);
                SimulationEngine engine(logger);
                if (narrator) engine.set_narrator(narrator);
                engine.prepare(kSeed, small_world());
                if (narrator) narrator->wait_idle(std::chrono::seconds(10));
                for (int hour = 0; hour < 24; ++hour) engine.step(3600);
                snapshot = engine.snapshot()["data"];
                news = engine.news(0, 100000, 0, true)["data"];
                // The API serves narrations only to a client that asks.
                const auto plain = engine.news(0, 100000, 0, false)["data"];
                bool any = plain.contains("narrated") || plain.contains("narration_sequence");
                for (const auto& item : plain["items"]) any = any || item.contains("narrative");
                for (const auto& item : engine.snapshot()["data"]["event_stack"]) any = any || item.contains("narrative");
                check(!any, "without ?narration=realistic neither the feed nor the snapshot carries narrations");
                // The topology served from the cache is the topology.
                check(engine.topology_text() == dump_json(engine.topology()), "the cached topology response equals the built one");
                check(engine.topology_text() == dump_json(engine.topology()), "and stays equal when served again");
                engine.stop();
                engine.terminate();
            }
            std::filesystem::remove_all(dir);
        };
        auto backend = std::make_unique<ScriptedBackend>([](const std::string& facts) -> std::optional<std::string> {
            return std::string(facts.find("cleared") != std::string::npos ? "The incident has cleared and traffic is flowing normally again."
                                                                          : "An incident is affecting traffic in the area.");
        });
        auto narrator = std::make_shared<Narrator>(std::move(backend), NarratorOptions{});
        nlohmann::json with_snapshot, with_news, without_snapshot, without_news;
        run(narrator, with_snapshot, with_news);
        run(nullptr, without_snapshot, without_news);

        for (const char* key : {"nodes", "edges", "demand", "congestion", "signals", "active_incidents"})
            check(with_snapshot[key] == without_snapshot[key], std::string("a narrator leaves the snapshot's ") + key + " unchanged");
        check(with_news["items"].size() == without_news["items"].size(), "a narrator adds no news items");
        std::size_t narrated = 0, incidents = 0;
        bool same_text = true;
        for (std::size_t i = 0; i < with_news["items"].size() && i < without_news["items"].size(); ++i) {
            const auto& w = with_news["items"][i];
            const auto& o = without_news["items"][i];
            same_text = same_text && w["message"] == o["message"] && w["data"] == o["data"] && w["template_id"] == o["template_id"];
            if (w["template_id"].get<std::string>().rfind("INCIDENT_", 0) == 0) {
                ++incidents;
                if (w.contains("narrative")) ++narrated;
            }
            check(!o.contains("narrative"), "without a narrator no item carries a narrative");
        }
        check(same_text, "a narrator leaves every item's text and data unchanged");
        check(incidents > 0 && narrated == incidents, "every incident item, prefetched at install, carries its narration");
        check(with_news.contains("narration_sequence") && !without_news.contains("narration_sequence"),
              "the narration cursor is only offered when a narrator is attached");
    }

    // ---- Large snapshots are assembled in order -------------------------------
    {
        const auto dir = temp_path("large");
        std::filesystem::remove_all(dir);
        {
            RuntimeLogger logger(dir);
            SimulationEngine engine(logger);
            auto cfg = small_world();
            cfg.grid_width = 70;
            cfg.grid_height = 70;
            engine.prepare(kSeed, cfg);
            engine.step(600);
            const auto snap = engine.snapshot()["data"];
            bool ordered = snap["edges"].size() > 16384;
            for (std::size_t i = 0; ordered && i < snap["edges"].size(); ++i) ordered = snap["edges"][i]["id"] == i;
            check(ordered, "edges built in parallel slices come back in id order");
            engine.terminate();
        }
        std::filesystem::remove_all(dir);
    }

    if (failures) {
        std::cerr << failures << " narrator check(s) failed\n";
        return 1;
    }
    std::cout << "narrator: all checks passed\n";
    return 0;
}
