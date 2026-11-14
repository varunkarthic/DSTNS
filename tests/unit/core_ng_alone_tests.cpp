// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng on its own: this program links dstns_core_ng and dstns_common, and not core-legacy. It registers core-ng
// alone in the runtime host and runs a world through a day and back. If core-ng still needed any of core-legacy's
// code, this would not link; if the host still fell back to core-legacy, it would refuse the run.
#include "dstns/core-ng/identity.hpp"
#include "dstns/core-ng/selection.hpp"
#include "dstns/engine.hpp"
#include "dstns/logging.hpp"

#include <filesystem>
#include <iostream>

using namespace dstns;

int main() {
    try {
        const auto directory = std::filesystem::temp_directory_path() / "dstns-core-ng-alone";
        std::filesystem::remove_all(directory);
        {
            RuntimeLogger logger(directory);
            SimulationEngine engine(logger);
            engine.register_engine(core_ng::kEngineId, core_ng::hooks(), core_ng::identity());
            if (engine.engines() != std::vector<std::string>{core_ng::kEngineId}) throw std::runtime_error("the host has an engine of its own");
            ScenarioConfig config;
            config.engine = core_ng::kEngineId;
            config.grid_width = 7;
            config.grid_height = 7;
            config.playback_duration_s = 600;
            engine.prepare(Seed128::from_decimal("42"), config);
            engine.seek(30'000, false);
            const auto at = engine.snapshot()["data"].dump();
            engine.seek(4'000, false);
            engine.seek(30'000, false);
            if (engine.snapshot()["data"].dump() != at) throw std::runtime_error("seeking back and forward changed the state");
            // A run on an engine the host was not given is refused, not run on some other engine.
            ScenarioConfig legacy = config;
            legacy.engine = "core-legacy";
            bool refused = false;
            try {
                engine.prepare(Seed128::from_decimal("42"), legacy);
            } catch (const std::invalid_argument&) {
                refused = true;
            }
            if (!refused) throw std::runtime_error("an engine the host was not given ran anyway");
            engine.stop();
            engine.terminate();
        }
        std::filesystem::remove_all(directory);
        std::cout << "[core-ng-alone] core-ng runs a world with no core-legacy code linked\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
