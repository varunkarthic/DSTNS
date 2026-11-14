// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's checkpoints (release 7b). Each engine runs the same world forward to 06:00, back across its checkpoints to
// 01:06:40, and forward to 06:00 again. The state at 06:00 must be the same both times, the state after going back
// must be the state a straight run has there, and core-ng must give exactly what core-legacy gives at every stop.
#include "dstns/core-ng/selection.hpp"
#include "dstns/engine.hpp"
#include "dstns/logging.hpp"

#include <filesystem>
#include <iostream>
#include <map>
#include <string>

using namespace dstns;

namespace {
void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

std::map<std::string, std::string> run(const std::string& name, std::uint32_t every = 900, double storm_min = 45) {
    const auto directory = std::filesystem::temp_directory_path() / ("dstns-timeline-" + name);
    std::filesystem::remove_all(directory);
    std::map<std::string, std::string> out;
    {
        RuntimeLogger logger(directory);
        SimulationEngine engine(logger);
        engine.register_engine(core_ng::kEngineId, core_ng::hooks());
        ScenarioConfig config;
        config.engine = name;
        config.grid_width = 7;
        config.grid_height = 7;
        config.dws_frequency = 4;
        config.playback_duration_s = 600;
        config.checkpoint_interval_s = every;
        config.dws_min_minutes = storm_min;
        engine.prepare(Seed128::from_decimal("382923"), config);
        const auto at = [&](std::uint32_t s) {
            engine.seek(s, false);
            return sha256(engine.snapshot()["data"].dump());
        };
        out["straight 01:06:40"] = at(4'000);
        out["first 06:00"] = at(21'600);
        out["back to 01:06:40"] = at(4'000);
        out["again 06:00"] = at(21'600);
        out["end of day"] = at(86'399);
        // The memory of a whole day's checkpoints, for release 8's measure; not compared between engines.
        const auto [bytes, count] = engine.checkpoint_memory();
        out["~bytes"] = std::to_string(bytes);
        out["~count"] = std::to_string(count);
        // Back from the end of the day, over every checkpoint: the same state as on the way.
        out["back again 06:00"] = at(21'600);
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(directory);
    return out;
}
} // namespace

int main() {
    try {
        const auto legacy = run("core-legacy");
        const auto ng = run(core_ng::kEngineId);
        const auto bytes = [](const std::map<std::string, std::string>& r) { return std::stoull(r.at("~bytes")); };
        std::cout << "[timeline-ng] a day's checkpoints: core-legacy " << bytes(legacy) / 1024 << " KiB in " << legacy.at("~count")
                  << ", core-ng " << bytes(ng) / 1024 << " KiB in " << ng.at("~count") << "\n";
        check(bytes(ng) * 2 <= bytes(legacy), "core-ng's checkpoints should take at most half of core-legacy's memory");
        for (const auto& result : {legacy, ng}) {
            check(result.at("first 06:00") == result.at("back again 06:00"), "going back from the end of the day changes the state at 06:00");
            check(result.at("first 06:00") == result.at("again 06:00"), "going back and forward again changes the state at 06:00");
            check(result.at("straight 01:06:40") == result.at("back to 01:06:40"), "going back does not give the state a straight run has there");
        }
        for (const auto& [stop, hash] : legacy)
            if (stop[0] != '~') check(ng.at(stop) == hash, "core-ng differs from core-legacy at " + stop);
        // Checkpoint spacing is memory, never results (#18): every 30 minutes, half as many checkpoints, the same state.
        const auto sparse = run(core_ng::kEngineId, 1800);
        check(sparse.at("~count") == "48", "a checkpoint every 1800 s keeps 48 a day, not " + sparse.at("~count"));
        for (const auto& [stop, hash] : ng)
            if (stop[0] != '~') check(sparse.at(stop) == hash, "the checkpoint spacing changed the state at " + stop);
        // Storm durations are part of the world: longer storms make another day, on both engines alike.
        const auto stormy = run("core-legacy", 900, 100), stormy_ng = run(core_ng::kEngineId, 900, 100);
        check(stormy.at("first 06:00") != legacy.at("first 06:00"), "storm_min_minutes did not change the world");
        check(stormy.at("first 06:00") == stormy_ng.at("first 06:00"), "the engines differ with longer storms");
        std::cout << "[timeline-ng] checkpoints: seeking back and forward gives the same state on both engines\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
