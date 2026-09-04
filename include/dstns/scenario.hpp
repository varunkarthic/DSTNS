#pragma once

#include "dstns/model.hpp"

#include <filesystem>

namespace dstns {

class ScenarioCompiler {
public:
    [[nodiscard]] Scenario compile(Seed128 seed, const ScenarioConfig& config) const;
    void export_sumo(const Scenario& scenario, const std::filesystem::path& directory) const;
private:
    void build_canonical_grid(Scenario& scenario, const DeterministicRng& rng) const;
    void place_bus_stops(Scenario& scenario) const;
    void place_buildings(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_signals(Scenario& scenario) const;
    void plan_hotspots(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_trips(Scenario& scenario, const DeterministicRng& rng) const;
    void plan_weather(Scenario& scenario, const DeterministicRng& rng) const;
    void calculate_hashes(Scenario& scenario) const;
};

} // namespace dstns
