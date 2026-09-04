#include "dstns/engine.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <filesystem>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
    std::string seed_str = (argc >= 2) ? argv[1] : "0x123456789ABCDEF0123456789ABCDEF0";
    auto seed = dstns::Seed128::parse(seed_str);

    dstns::ScenarioConfig cfg;
    cfg.playback_duration_s = 600;
    cfg.grid_width = 8;
    cfg.grid_height = 8;
    cfg.dws_frequency = 4;

    std::cout << "Replay Verification Tool\n";
    std::cout << "Compiling Run 1 with seed: " << seed.hex() << "\n";
    dstns::ScenarioCompiler compiler;
    auto s1 = compiler.compile(seed, cfg);

    std::cout << "Compiling Run 2 with same seed: " << seed.hex() << "\n";
    auto s2 = compiler.compile(seed, cfg);

    if (s1.graph_hash != s2.graph_hash) {
        std::cerr << "FAIL: Graph hash mismatch! " << s1.graph_hash << " vs " << s2.graph_hash << "\n";
        return 1;
    }
    if (s1.scenario_hash != s2.scenario_hash) {
        std::cerr << "FAIL: Scenario hash mismatch! " << s1.scenario_hash << " vs " << s2.scenario_hash << "\n";
        return 1;
    }
    if (s1.event_hash != s2.event_hash) {
        std::cerr << "FAIL: Event hash mismatch! " << s1.event_hash << " vs " << s2.event_hash << "\n";
        return 1;
    }

    std::cout << "PASS: Graph Hash (" << s1.graph_hash << ") matched.\n";
    std::cout << "PASS: Scenario Hash (" << s1.scenario_hash << ") matched.\n";
    std::cout << "PASS: Event Hash (" << s1.event_hash << ") matched.\n";

    // Replay checkpoint seek verification
    auto temp = std::filesystem::temp_directory_path() / ("dstns-replay-" + s1.scenario_hash.substr(7, 8));
    std::filesystem::remove_all(temp);
    {
        dstns::RuntimeLogger logger(temp);
        dstns::SimulationEngine engine(logger);
        engine.start(seed, cfg);
        engine.pause();
        engine.seek(1800, false);
        auto snap1 = engine.snapshot()["data"];
        engine.seek(3600, false);
        engine.seek(1800, false);
        auto snap2 = engine.snapshot()["data"];
        if (snap1 != snap2) {
            std::cerr << "FAIL: Checkpoint seek reconstruction mismatch!\n";
            std::filesystem::remove_all(temp);
            return 1;
        }
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(temp);

    std::cout << "PASS: Seek reconstruction matched exactly.\n";
    std::cout << "Deterministic replay verified successfully.\n";
    return 0;
}
