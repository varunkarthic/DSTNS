#include "dstns/engine.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

nlohmann::json run_snapshot(const dstns::Seed128& seed, const dstns::ScenarioConfig& config, const std::string& label) {
    const auto directory = std::filesystem::temp_directory_path() / ("dstns-replay-verify-" + label);
    std::filesystem::remove_all(directory);
    nlohmann::json snapshot;
    {
        dstns::RuntimeLogger logger(directory);
        dstns::SimulationEngine engine(logger);
        engine.prepare(seed, config);
        engine.seek(12'345, false);
        snapshot = engine.snapshot()["data"];
        engine.stop();
        engine.terminate();
    }
    std::filesystem::remove_all(directory);
    return snapshot;
}

void verify(const dstns::Seed128& seed, const dstns::ScenarioConfig& config, const std::string& label) {
    dstns::ScenarioCompiler compiler;
    const auto first = compiler.compile(seed, config);
    const auto second = compiler.compile(seed, config);

    if (first.graph_hash != second.graph_hash) throw std::runtime_error(label + " graph hash mismatch");
    if (first.scenario_hash != second.scenario_hash) throw std::runtime_error(label + " scenario hash mismatch");
    if (first.event_hash != second.event_hash) throw std::runtime_error(label + " event hash mismatch");
    if (run_snapshot(seed, config, label + "-first") != run_snapshot(seed, config, label + "-second")) {
        throw std::runtime_error(label + " engine snapshot mismatch at 12345 virtual seconds");
    }

    std::cout << "PASS [" << label << "]: graph, scenario, event, and full runtime snapshot matched.\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        const std::string seed_string = (argc >= 2) ? argv[1] : "0x123456789ABCDEF0123456789ABCDEF0";
        const auto seed = dstns::Seed128::parse(seed_string);

        dstns::ScenarioConfig grid;
        grid.playback_duration_s = 600;
        grid.grid_width = 8;
        grid.grid_height = 8;
        grid.dws_frequency = 4;

        std::cout << "Replay Verification Tool\n";
        std::cout << "Seed: " << seed.hex() << "\n";
        verify(seed, grid, "grid");

        auto osm = grid;
        osm.osm_file = "tests/fixtures/roads.osm.xml";
        osm.max_nodes = 50;
        verify(seed, osm, "osm");

        std::cout << "Deterministic compile and runtime replay verified successfully.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
