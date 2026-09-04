#include "dstns/scenario.hpp"

#include <iostream>
#include <stdexcept>

int main() {
    try {
        using namespace dstns;
        std::cout << "[replay-tests] Testing cross-run deterministic reproducibility...\n";

        ScenarioCompiler compiler;
        auto seed = Seed128::parse("0xFEEDFACECAFED00D123456789ABCDEF0");

        ScenarioConfig cfg;
        cfg.grid_width = 7;
        cfg.grid_height = 7;
        cfg.dws_frequency = 4;
        cfg.playback_duration_s = 600;

        auto s1 = compiler.compile(seed, cfg);
        auto s2 = compiler.compile(seed, cfg);

        if (s1.graph_hash != s2.graph_hash) throw std::runtime_error("Graph hash diverged across identical compiles");
        if (s1.scenario_hash != s2.scenario_hash) throw std::runtime_error("Scenario hash diverged across identical compiles");
        if (s1.event_hash != s2.event_hash) throw std::runtime_error("Event hash diverged across identical compiles");

        std::cout << "[replay-tests] Reproducibility golden check passed.\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
