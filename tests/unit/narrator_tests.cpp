// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Narration: the fact builder, the checks on what a model writes, the narrator's
// queue and caches, and the guarantee that matters most - a narrator changes
// what the operator reads and nothing about the run.
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
        const std::string facts = "Event: an incident has started\nKind: collision\nRoad: Uhuru Street\n"
                                  "Area: the central district\nTraffic speed: 35% of normal\nExpected to clear: 14:20\n";
        auto ok = accept_narration("A collision on Uhuru Street in the central district has slowed traffic to 35% of normal; it should clear by 14:20.", facts);
        check(!ok.has_value(), "advice-like 'should' is refused");
        ok = accept_narration("A collision on Uhuru Street in the central district has slowed traffic to 35% of normal. It is expected to clear by 14:20.", facts);
        check(ok.has_value(), "a faithful sentence is kept");
        check(!accept_narration("A collision on Uhuru Street has slowed traffic to 40% of normal.", facts).has_value(),
              "a number that is not among the facts is refused");
        check(!accept_narration("A collision on Uhuru Street has left two people injured.", facts).has_value(),
              "injuries the facts do not mention are refused");
        check(!accept_narration("Rain may make the road slippery on Uhuru Street today.", facts).has_value(),
              "speculation is refused");
        check(!accept_narration("Event: an incident has started. Road: Uhuru Street.", facts).has_value(),
              "facts echoed back as labels are refused");
        check(!accept_narration("ok", facts).has_value(), "too short is refused");
        check(!accept_narration(std::string(400, 'a'), facts).has_value(), "too long is refused");
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
            const auto again = narration_request(context, "INCIDENT_ACTIVATED", message, data, 0);
            check(again && again->key == request->key, "identical facts share a key, whatever the time they fire");
        }
        check(!narration_request(context, "DEMAND_CHANGED", "x", nlohmann::json::object(), 0).has_value(),
              "demand changes are not narrated");
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
                if (facts.find("Bad Road") != std::string::npos) return std::string("Two people were injured on Bad Road.");
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
                news = engine.news(0, 100000, 0)["data"];
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
