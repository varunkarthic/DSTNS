// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's lifecycle table, and the engine held to it: ordinary use and races between a jump and every control that
// may interrupt one must make no transition outside the table.
#include "dstns/core-ng/lifecycle.hpp"
#include "dstns/core-ng/selection.hpp"
#include "dstns/engine.hpp"
#include "dstns/logging.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace dstns;
namespace lc = dstns::core_ng::lifecycle;

namespace {
void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

std::mutex seen_mutex;
std::vector<std::string> illegal;

struct Harness {
    std::filesystem::path directory;
    RuntimeLogger logger;
    SimulationEngine engine;
    explicit Harness(const std::string& name)
        : directory((std::filesystem::remove_all(std::filesystem::temp_directory_path() / ("dstns-lifecycle-" + name)),
                     std::filesystem::temp_directory_path() / ("dstns-lifecycle-" + name))),
          logger(directory), engine(logger) {
        engine.register_engine(core_ng::kEngineId, core_ng::hooks());
        engine.set_transition_guard([](Lifecycle from, Lifecycle to) {
            const bool ok = lc::allowed(from, to);
            if (!ok) {
                std::lock_guard lock(seen_mutex);
                illegal.push_back(std::string(to_string(from)) + " -> " + to_string(to));
            }
            return ok;
        });
    }
    ~Harness() {
        engine.terminate();
    }
};

ScenarioConfig grid() {
    ScenarioConfig config;
    config.grid_width = 7; config.grid_height = 7; config.dws_frequency = 2; config.playback_duration_s = 600;
    config.engine = core_ng::kEngineId;
    return config;
}

Lifecycle state(const SimulationEngine& engine) { return engine.lifecycle(); }

template <class F> void quietly(F&& f) {
    try { f(); } catch (const std::exception&) {}  // a refused control is fine here; only transitions are judged
}

void wait_until_not_preparing(SimulationEngine& engine) {
    for (int i = 0; i < 2000 && state(engine) == Lifecycle::Preparing; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
}
} // namespace

int main() {
    try {
        // The table: what must and must not be possible.
        using enum Lifecycle;
        for (const auto& [from, to] : std::vector<std::pair<Lifecycle, Lifecycle>>{
                 {Idle, Preparing}, {Preparing, Ready}, {Ready, Running}, {Running, Seeking}, {Seeking, Paused},
                 {Running, Completed}, {Completed, Seeking}, {Stopping, Stopped}, {Stopped, Idle}, {Paused, Terminating}})
            check(lc::allowed(from, to), std::string("allows ") + to_string(from) + " -> " + to_string(to));
        for (const auto& [from, to] : std::vector<std::pair<Lifecycle, Lifecycle>>{
                 {Terminating, Idle}, {Terminating, Stopped}, {Stopped, Stopping}, {Idle, Running}, {Idle, Seeking},
                 {Completed, Running}, {Stopping, Idle}, {Paused, Completed}, {Booting, Idle}, {Idle, Error}})
            check(!lc::allowed(from, to), std::string("refuses ") + to_string(from) + " -> " + to_string(to));
        for (const auto& [from, to] : lc::table()) check(from != Terminating, "nothing leaves Terminating");

        const auto seed = Seed128::from_decimal("42");
        // Ordinary use, start to end.
        {
            Harness h("ordinary");
            auto& e = h.engine;
            e.prepare(seed, grid());
            check(state(e) == Ready, "prepared");
            e.seek(3600, false);
            e.play();
            e.pause();
            e.step(60);
            e.seek(86'400, false);
            check(state(e) == Completed, "the end completes the day");
            e.seek(1800, false);
            e.stop();
            const auto again = e.stop();
            check(again.at("changed") == false && state(e) == Stopped, "a second stop changes nothing");
            e.reset();
            e.reset();
            check(state(e) == Idle, "reset");
        }
        // A failed preparation leaves the world that was there as it was.
        {
            Harness h("failure");
            auto& e = h.engine;
            e.prepare(seed, grid());
            e.stop();
            const auto run = e.status().at("data").at("run_id");
            auto broken = grid();
            broken.osm_file = "tests/fixtures/no-such-map.osm.xml";
            quietly([&] { e.prepare(seed, broken); });
            check(state(e) == Stopped, std::string("a failed prepare returns to Stopped, not ") + to_string(state(e)));
            check(e.status().at("data").at("run_id") == run, "the world that was there is intact");
            e.seek(600, false);
            check(state(e) == Paused, "and can still be used");
        }
        // Reset and stop never undo termination.
        {
            Harness h("termination");
            auto& e = h.engine;
            e.prepare(seed, grid());
            e.terminate();
            quietly([&] { e.reset(); });
            quietly([&] { e.stop(); });
            check(state(e) == Terminating, std::string("terminating stays, not ") + to_string(state(e)));
        }
        // Races: a long jump, and each control that may interrupt it, a few milliseconds in.
        const std::vector<std::pair<std::string, std::function<void(SimulationEngine&)>>> interruptions{
            {"stop", [](SimulationEngine& e) { e.stop(); }},
            {"reset", [](SimulationEngine& e) { e.reset(); }},
            {"pause", [](SimulationEngine& e) { e.pause(); }},
            {"play", [](SimulationEngine& e) { e.play(); }},
            {"seek back", [](SimulationEngine& e) { e.seek(100, false); }},
            {"seek on", [](SimulationEngine& e) { e.seek(86'000, true); }},
            {"step", [](SimulationEngine& e) { e.step(10); }},
            {"prepare", [&](SimulationEngine& e) { e.prepare(Seed128::from_decimal("7"), grid()); }},
            {"regenerate", [](SimulationEngine& e) { e.regenerate_world(); }},
            {"staged", [](SimulationEngine& e) { e.regenerate_world({{"stage", true}}); e.commit_world(); }},
            {"discard", [](SimulationEngine& e) { e.regenerate_world({{"stage", true}}); e.discard_world(); }},
            {"terminate", [](SimulationEngine& e) { e.terminate(); }},
        };
        for (const auto& [name, interrupt] : interruptions) {
            for (int delay_ms : {0, 2, 10, 40}) {
                Harness h("race");
                auto& e = h.engine;
                e.prepare(seed, grid());
                std::thread jump([&] { quietly([&] { e.seek(86'400, true); }); });
                std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
                quietly([&] { interrupt(e); });
                jump.join();
                wait_until_not_preparing(e);
                quietly([&] { e.stop(); });
                quietly([&] { e.reset(); });
            }
        }
        // A start, interrupted while it prepares.
        for (const auto& name : {"stop", "reset", "terminate", "prepare"}) {
            Harness h("start");
            auto& e = h.engine;
            e.start_async(seed, grid());
            quietly([&] {
                if (std::string(name) == "stop") e.stop();
                else if (std::string(name) == "reset") e.reset();
                else if (std::string(name) == "terminate") e.terminate();
                else e.prepare(seed, grid());
            });
            wait_until_not_preparing(e);
        }

        if (!illegal.empty()) {
            for (const auto& edge : illegal) std::cerr << "illegal: " << edge << "\n";
            throw std::runtime_error(std::to_string(illegal.size()) + " transitions outside the lifecycle table");
        }
        std::cout << "[lifecycle-ng] table, ordinary use, failure, termination and " << interruptions.size() * 4
                  << " races: no transition outside the table\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
