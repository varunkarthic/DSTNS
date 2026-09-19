// Playback stepping and world regeneration.
//
// Stepping must move the model by exactly the requested amount of virtual time
// and always leave the run paused. Regeneration must replace the world with one
// derived from a fresh seed, keep the old world intact when generation fails,
// and never let the observer choose the scenario configuration.
#include "dstns/engine.hpp"
#include "dstns/scenario.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

using namespace dstns;

namespace {
int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    } else {
        std::cout << "  ok  " << message << '\n';
    }
}

template <typename F>
bool throws_logic(F&& f) {
    try { f(); } catch (const std::invalid_argument&) { return false; } catch (const std::logic_error&) { return true; }
    return false;
}
template <typename F>
bool throws_invalid(F&& f) {
    try { f(); } catch (const std::invalid_argument&) { return true; } catch (...) { return false; }
    return false;
}

ScenarioConfig fixture(std::uint32_t side = 6) {
    ScenarioConfig c;
    c.playback_duration_s = 3600;
    c.grid_width = side;
    c.grid_height = side;
    return c;
}

nlohmann::json wait_for_world(SimulationEngine& engine, double timeout_s = 60) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::duration<double>(timeout_s);
    while (std::chrono::steady_clock::now() < until) {
        auto s = engine.world_status()["data"];
        if (s["state"] != "generating") return s;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return engine.world_status()["data"];
}

std::string lifecycle(const SimulationEngine& engine) {
    return engine.status()["data"]["lifecycle"].get<std::string>();
}
std::uint32_t virtual_s(const SimulationEngine& engine) {
    return engine.status()["clock"]["virtual_day_seconds"].get<std::uint32_t>();
}
}  // namespace

int main() {
    const auto dir = std::filesystem::temp_directory_path() / "dstns-world-tests";
    std::filesystem::create_directories(dir);
    RuntimeLogger logger(dir);
    const auto seed = Seed128::parse("0x0123456789abcdef");

    std::cout << "step\n";
    {
        SimulationEngine engine(logger);
        check(throws_logic([&] { engine.step(60); }), "step without a simulation is a lifecycle conflict");
        engine.start(seed, fixture());
        check(lifecycle(engine) == "RUNNING", "start runs");
        const auto before = virtual_s(engine);
        auto r = engine.step(60);
        check(lifecycle(engine) == "PAUSED", "step from running leaves the run paused");
        check(r["stepped_seconds"].get<std::uint32_t>() == 60, "step reports the seconds it advanced");
        check(virtual_s(engine) == r["simulated_seconds"].get<std::uint32_t>(), "step result matches the clock");
        check(virtual_s(engine) >= before + 60, "clock advanced by at least the step");
        const auto at = virtual_s(engine);
        engine.step(1);
        check(virtual_s(engine) == at + 1, "one-second step is exact while paused");
        check(lifecycle(engine) == "PAUSED", "step while paused stays paused");
        check(throws_invalid([&] { engine.step(0); }), "zero-second step is rejected");
        check(throws_invalid([&] { engine.step(3601); }), "steps above one hour are rejected");
        engine.terminate();
    }

    std::cout << "step determinism\n";
    {
        SimulationEngine a(logger), b(logger);
        a.prepare(seed, fixture());
        b.prepare(seed, fixture());
        for (int i = 0; i < 30; ++i) a.step(60);
        b.seek(1800, false);
        check(virtual_s(a) == 1800 && virtual_s(b) == 1800, "thirty one-minute steps land on 00:30:00");
        check(a.snapshot()["data"] == b.snapshot()["data"], "stepping and seeking produce identical physics");
        a.terminate();
        b.terminate();
    }

    std::cout << "step to the end of the day\n";
    {
        SimulationEngine engine(logger);
        engine.prepare(seed, fixture());
        engine.seek(86400 - 30, false);
        auto r = engine.step(60);
        check(r["simulated_seconds"].get<std::uint32_t>() == 86400, "final step clamps at 24:00:00");
        check(lifecycle(engine) == "COMPLETED", "stepping onto 24:00:00 completes the run");
        check(throws_logic([&] { engine.step(1); }), "a completed day cannot be stepped further");
        engine.seek(3600, false);
        check(lifecycle(engine) == "PAUSED", "seeking back from completion pauses the run");
        engine.terminate();
    }

    std::cout << "world regeneration\n";
    {
        SimulationEngine engine(logger);
        check(throws_logic([&] { engine.regenerate_world(); }), "regeneration requires an active world");
        check(engine.world_status()["data"]["state"] == "idle", "status is idle before any request");

        engine.start(seed, fixture());
        engine.set_tick_rate(2);
        engine.step(600);
        const auto old_run = engine.status()["run_id"].get<std::string>();
        const auto old_seed = engine.status()["global_seed"].get<std::string>();

        check(throws_logic([&] { engine.regenerate_world({{"expected_run_id", "run_other"}}); }),
              "a stale run guard cancels regeneration");
        check(engine.world_status()["data"]["state"] == "idle", "a cancelled request leaves no job behind");

        auto accepted = engine.regenerate_world({{"expected_run_id", old_run}})["data"];
        check(accepted["state"] == "generating" || accepted["state"] == "ready", "request is accepted");
        check(accepted["seed"].get<std::string>().size() > 2, "the new seed is reported immediately");
        check(accepted["seed"] != old_seed, "the new seed differs from the current one");
        check(accepted["previous_run_id"] == old_run, "the job records the world it replaces");

        auto done = wait_for_world(engine);
        check(done["state"] == "ready", "generation completes");
        check(done["stage"] == "ready", "final stage is ready");
        check(done["error"].is_null(), "no error is reported on success");
        const auto status = engine.status();
        check(status["run_id"] == done["run_id"], "the new run is active");
        check(status["run_id"] != old_run, "run identity changed");
        // The run is named by its decimal seed; the hexadecimal form is internal.
        check(status["seed"] == accepted["seed"], "active seed is the generated seed");
        check(status["global_seed"] == accepted["seed_hex"], "the internal hexadecimal form matches too");
        check(status["seed"].get<std::string>().find_first_not_of("0123456789") == std::string::npos,
              "the seed an operator sees is a plain number");
        check(status["seed"].get<std::string>().size() <= 20, "a generated seed is short enough to retype");
        check(lifecycle(engine) == "PAUSED", "a regenerated world starts paused");
        check(virtual_s(engine) == 0, "a regenerated world starts at 00:00:00");
        check(status["clock"]["tick_rate"].get<double>() == 2.0, "the operator's requested rate carries over");
        const auto news = engine.news(0, 50)["data"]["items"];
        check(!news.empty() && news[0]["template_id"] == "SCENARIO_INITIALIZED", "news restarts with the new scenario");
        check(engine.snapshot()["data"]["edges"].size() > 0, "the new world has a road network");

        engine.play();
        check(lifecycle(engine) == "RUNNING", "the new world plays");
        engine.terminate();
    }

    std::cout << "world regeneration failure keeps the previous world\n";
    {
        // A pinned map file that disappears makes compilation fail after the
        // request is accepted, exercising the asynchronous failure path.
        const auto source = std::filesystem::path("tests/fixtures/roads.osm.xml");
        const auto pinned = dir / "pinned-roads.osm.xml";
        std::filesystem::copy_file(source, pinned, std::filesystem::copy_options::overwrite_existing);
        auto config = fixture();
        config.osm_file = pinned.string();

        SimulationEngine engine(logger);
        engine.start(seed, config);
        engine.step(300);
        const auto old_run = engine.status()["run_id"].get<std::string>();
        const auto old_time = virtual_s(engine);
        const auto old_snapshot = engine.snapshot()["data"];
        std::filesystem::remove(pinned);

        engine.regenerate_world();
        auto done = wait_for_world(engine);
        check(done["state"] == "failed", "generation reports failure");
        check(done["error"].is_object() && done["error"]["code"] == "WORLD_GENERATION_FAILED",
              "failure carries a machine-readable code");
        check(!done["error"]["message"].get<std::string>().empty(), "failure carries a message");
        check(engine.status()["run_id"] == old_run, "the previous world is still active");
        check(virtual_s(engine) == old_time, "the previous world's clock is untouched");
        check(engine.snapshot()["data"] == old_snapshot, "the previous world's state is untouched");
        check(lifecycle(engine) == "PAUSED", "the previous world keeps its lifecycle");

        // A failed job does not block a retry.
        std::filesystem::copy_file(source, pinned, std::filesystem::copy_options::overwrite_existing);
        engine.regenerate_world();
        done = wait_for_world(engine);
        check(done["state"] == "ready", "a retry after failure succeeds");
        check(engine.status()["run_id"] != old_run, "the retry installs a new world");
        engine.terminate();
        std::filesystem::remove(pinned);
    }

    std::cout << "seed representation\n";
    {
        // The seed an operator types is a number, and the run is named by that
        // same number; the hexadecimal form is an internal detail.
        check(Seed128::from_decimal("0").decimal() == "0", "zero round-trips");
        check(Seed128::from_decimal("12345").decimal() == "12345", "a small seed round-trips");
        check(Seed128{0, 42}.decimal() == "42", "a 64-bit value reads as itself");
        const std::string max128 = "340282366920938463463374607431768211455";
        check(Seed128::from_decimal(max128).decimal() == max128, "the largest 128-bit seed round-trips");
        check(Seed128::from_decimal(max128).hex() == "0xffffffffffffffffffffffffffffffff", "and matches its hexadecimal form");
        check(Seed128::parse("0x5089050192221083c848bf3e12e22a4f").decimal() ==
                  "107049685868914714890632172424598268495",
              "a hexadecimal seed has one decimal name");
        check(Seed128::from_decimal("107049685868914714890632172424598268495").hex() ==
                  "0x5089050192221083c848bf3e12e22a4f",
              "and that decimal name parses back to it");
        check(throws_invalid([&] { (void)Seed128::from_decimal("340282366920938463463374607431768211456"); }),
              "a value above 128 bits is rejected");
        check(throws_invalid([&] { (void)Seed128::from_decimal("12ab"); }), "a non-numeric seed is rejected");
        check(throws_invalid([&] { (void)Seed128::from_decimal(""); }), "an empty seed is rejected");

        // The same number starts the same world, whichever form it arrives in.
        SimulationEngine a(logger), b(logger);
        a.prepare(Seed128::from_decimal("12345"), fixture());
        b.prepare(Seed128::parse("0x3039"), fixture());
        check(a.status()["seed"] == "12345", "the run reports the seed it was started with");
        check(a.snapshot()["data"] == b.snapshot()["data"], "decimal and hexadecimal forms start the same world");
        a.terminate();
        b.terminate();
    }

    std::cout << "playback rate range\n";
    {
        SimulationEngine engine(logger);
        engine.prepare(seed, fixture());
        check(engine.set_tick_rate(10)["requested_tick_rate"].get<double>() == 10.0, "10x is an accepted playback rate");
        check(engine.set_tick_rate(0.25)["requested_tick_rate"].get<double>() == 0.25, "0.25x is an accepted playback rate");
        check(throws_invalid([&] { (void)engine.set_tick_rate(10.5); }), "rates above 10x are rejected");
        check(throws_invalid([&] { (void)engine.set_tick_rate(0); }), "a zero rate is rejected");
        auto config = fixture();
        config.tick_rate = 10;
        check(!throws_invalid([&] { (void)ScenarioCompiler{}.compile(seed, config); }), "a scenario may start at 10x");
        config.tick_rate = 11;
        check(throws_invalid([&] { (void)ScenarioCompiler{}.compile(seed, config); }), "a scenario above 10x is rejected");
        engine.terminate();
    }

    std::cout << "place demand types\n";
    {
        SimulationEngine engine(logger);
        engine.prepare(seed, fixture());
        const auto topology = engine.topology()["data"];
        const auto demand = engine.snapshot()["data"]["demand"];
        std::size_t typed = 0;
        bool known = true, reported = true;
        for (const auto& f : topology["features"]) {
            reported = reported && f.contains("demand_type");
            if (!f.contains("demand_type") || f["demand_type"].is_null()) continue;
            ++typed;
            const auto t = f["demand_type"].get<std::string>();
            known = known && (t == "school" || t == "office" || t == "mall" || t == "store");
        }
        check(reported, "every feature reports demand_type");
        check(typed > 0, "the fixture has demand-modelled places");
        check(known, "demand types are school, office, mall or store");
        check(typed == demand.size(), "exactly the typed places carry a demand entry");
        engine.terminate();
    }

    if (failures) {
        std::cerr << failures << " world test(s) failed\n";
        return 1;
    }
    std::cout << "World and stepping tests passed\n";
    return 0;
}
