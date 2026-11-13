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

std::map<std::string, std::string> run(const std::string& name) {
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
        engine.prepare(Seed128::from_decimal("382923"), config);
        const auto at = [&](std::uint32_t s) {
            engine.seek(s, false);
            return sha256(engine.snapshot()["data"].dump());
        };
        out["straight 01:06:40"] = at(4'000);
        out["first 06:00"] = at(21'600);
        out["back to 01:06:40"] = at(4'000);
        out["again 06:00"] = at(21'600);
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
        for (const auto& result : {legacy, ng}) {
            check(result.at("first 06:00") == result.at("again 06:00"), "going back and forward again changes the state at 06:00");
            check(result.at("straight 01:06:40") == result.at("back to 01:06:40"), "going back does not give the state a straight run has there");
        }
        for (const auto& [stop, hash] : legacy) check(ng.at(stop) == hash, "core-ng differs from core-legacy at " + stop);
        std::cout << "[timeline-ng] checkpoints: seeking back and forward gives the same state on both engines\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
