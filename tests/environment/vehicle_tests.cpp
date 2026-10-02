// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Vehicle dynamics and the road coupling: the longitudinal force balance,
// power-limited speed on grades and in wind, Pregnolato's depth-speed
// relation, and, through the engine, scenario E (uphill and downhill arcs of
// one road behave differently) and scenario C (water on a road changes its
// state and the traffic on it).
#include "dstns/engine.hpp"
#include "dstns/environment/vehicles.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>

using namespace dstns;
using namespace dstns::env;

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
bool near(double a, double b, double tolerance) { return std::abs(a - b) <= tolerance; }

struct Engine {
    std::filesystem::path dir;
    std::unique_ptr<RuntimeLogger> logger;
    std::unique_ptr<SimulationEngine> engine;
    explicit Engine(const std::string& label) : dir(std::filesystem::temp_directory_path() / ("dstns-vehicle-" + label)) {
        std::filesystem::remove_all(dir);
        logger = std::make_unique<RuntimeLogger>(dir);
        compute::ComputeOptions cpu;
        cpu.backend = compute::BackendPreference::Cpu;
        engine = std::make_unique<SimulationEngine>(*logger, cpu);
    }
    ~Engine() {
        engine->terminate();
        engine.reset();
        std::filesystem::remove_all(dir);
    }
};

ScenarioConfig config(const std::string& dem) {
    ScenarioConfig c;
    c.playback_duration_s = 600;
    c.grid_width = 8;
    c.grid_height = 6;
    c.day = 0;
    c.month = 6;
    c.dws_frequency = 0;
    c.incidents = false;
    c.environment.dem_source = dem;
    return c;
}
} // namespace

int main() {
    std::cout << "the force balance\n";
    {
        const auto& car = vehicle_params(VehicleClass::SmallPassenger);
        const auto& bus = vehicle_params(VehicleClass::Bus);
        const double v = 13.9;
        const double flat = tractive_force(car, v, 0, 0);
        check(near(flat, car.rolling_coefficient * car.mass_kg * kGravityMps2 + 0.5 * kSeaLevelAirDensity * car.drag_area_m2 * v * v, 1e-9),
              "flat road: rolling resistance plus drag");
        check(tractive_force(car, v, 0.06, 0) > flat + 0.05 * car.mass_kg * kGravityMps2, "uphill adds m g sin(theta)");
        check(tractive_force(car, v, -0.06, 0) < flat, "downhill takes it away");
        check(tractive_force(car, v, 0, 5) > flat && tractive_force(car, v, 0, -5) < flat, "a headwind costs force, a tailwind saves it");
        check(near(tractive_force(car, v, 0, 0, 1.0) - flat, car.mass_kg, 1e-9), "accelerating at 1 m/s^2 adds m");
        check(energy_kwh_per_km(car, v, 0.05, 0) > energy_kwh_per_km(car, v, 0, 0) &&
                  energy_kwh_per_km(car, v, 0, 0) > energy_kwh_per_km(car, v, -0.01, 0),
              "energy per km rises uphill and falls downhill");
        check(energy_kwh_per_km(car, v, -0.2, 0) == 0, "braking energy is neither spent nor recovered");
        check(power_limited_speed(car, 0, 0, 16.7) == 16.7, "a car holds 60 km/h on the flat within its budget");
        const double bus_up = power_limited_speed(bus, 0.08, 0, 16.7), bus_flat = power_limited_speed(bus, 0, 0, 16.7);
        check(bus_up < bus_flat - 3, "a bus slows markedly on an 8% climb");
        check(power_limited_speed(bus, -0.08, 0, 16.7) == 16.7, "and does not speed past the limit going down");
        // At 60 km/h a bus has power to spare even into a gale; at motorway
        // speed a 15 m/s headwind takes more than its budget.
        check(power_limited_speed(bus, 0, 15, 30) < power_limited_speed(bus, 0, 0, 30) - 2, "a strong headwind slows it at motorway speed");
        check(grade_speed_factor(0, 0, 16.7) == 1.0 && grade_speed_factor(0, 0, 30) == 1.0, "the traffic stream's factor is exactly 1 on the flat");
        check(grade_speed_factor(0.08, 0, 16.7) < 1 && grade_speed_factor(-0.08, 0, 16.7) == 1.0, "below 1 uphill, exactly 1 downhill");
        check(grade_speed_factor(0.12, 0, 16.7) < grade_speed_factor(0.06, 0, 16.7), "steeper is slower");
    }

    std::cout << "water (Pregnolato et al. 2017)\n";
    {
        check(water_speed_factor(0) == 1.0, "dry: full speed");
        check(near(water_speed_factor(0.15), (0.0009 * 22500 - 0.5529 * 150 + 86.9448) / 86.9448, 1e-12), "150 mm: the published curve");
        check(water_speed_factor(0.30) == 0.0 && water_speed_factor(0.5) == 0.0, "300 mm stops a car");
        bool falling = true;
        for (int mm = 1; mm <= 300; ++mm) falling = falling && water_speed_factor(mm / 1000.0) <= water_speed_factor((mm - 1) / 1000.0);
        check(falling, "deeper water is never faster");
        check(vehicle_params(VehicleClass::Bus).wading_depth_m > vehicle_params(VehicleClass::SmallPassenger).wading_depth_m &&
                  vehicle_params(VehicleClass::Emergency).wading_depth_m > vehicle_params(VehicleClass::SmallPassenger).wading_depth_m,
              "buses and emergency vehicles wade deeper than cars");
    }

    std::cout << "scenario E: one road, two directions\n";
    {
        Engine run("grade");
        run.engine->prepare(Seed128::parse("0x5eed00000000000000000000000000d1"), config("synthetic:slope:0.10"));
        run.engine->seek(8 * 3600, false);
        const auto topo = run.engine->topology()["data"]["edges"];
        const auto roads = run.engine->road_environment(0, 5000)["data"]["items"];
        const auto snap = run.engine->snapshot()["data"]["edges"];
        double up_speed = 0, down_speed = 0, up_energy = 0, down_energy = 0;
        int pairs = 0;
        bool reversed = true;
        for (const auto& e : topo) {
            const auto id = e["id"].get<std::size_t>(), twin = e["reverse_twin"].get<std::size_t>();
            if (e["grade"].get<double>() <= 0.05) continue;  // eastbound, climbing
            reversed = reversed && near(roads[id]["grade"].get<double>(), -roads[twin]["grade"].get<double>(), 1e-12);
            up_speed += roads[id]["speed_multiplier"].get<double>();
            down_speed += roads[twin]["speed_multiplier"].get<double>();
            up_energy += roads[id]["energy_kwh_per_km"].get<double>();
            down_energy += roads[twin]["energy_kwh_per_km"].get<double>();
            check(snap[id]["env_speed_multiplier"].get<double>() < snap[twin]["env_speed_multiplier"].get<double>() || pairs > 0,
                  "the climbing arc's multiplier reaches the traffic step below its twin's");
            ++pairs;
        }
        check(pairs > 0 && reversed, "every climbing arc's twin descends by the same grade");
        check(up_speed < down_speed && near(down_speed / pairs, 1.0, 1e-12), "uphill arcs are slowed; downhill arcs are not sped up");
        check(up_energy > 2 * down_energy, "uphill arcs cost far more energy");
        double up_v = 0, down_v = 0;
        for (const auto& e : topo) {
            if (e["grade"].get<double>() <= 0.05) continue;
            up_v += snap[e["id"].get<std::size_t>()]["effective_speed_mps"].get<double>();
            down_v += snap[e["reverse_twin"].get<std::size_t>()]["effective_speed_mps"].get<double>();
        }
        check(up_v < down_v, "and traffic moves more slowly up the hill than down it");
    }

    std::cout << "scenario C: water on the road\n";
    {
        Engine run("water");
        auto c = config("synthetic:bowl:4");
        c.grid_width = 9;
        c.grid_height = 9;
        run.engine->prepare(Seed128::parse("0x5eed00000000000000000000000000d2"), c);
        run.engine->seek(12 * 3600, false);
        const auto before = run.engine->snapshot()["data"]["edges"];
        // A cloudburst over the bottom of the bowl.
        const auto nodes = run.engine->topology()["data"]["nodes"];
        const auto centre = nodes.size() / 2;
        (void)run.engine->add_weather(NodeId{static_cast<std::uint32_t>(centre)}, 1.0, 2000, 90, 0.5);
        run.engine->seek(13 * 3600 + 1800, false);
        const auto roads = run.engine->road_environment(0, 5000)["data"]["items"];
        const auto after = run.engine->snapshot()["data"]["edges"];
        std::size_t wet = 0, closed = 0, flooded_state = 0, slowed = 0;
        bool closed_empty = true;
        for (std::size_t e = 0; e < roads.size(); ++e) {
            if (roads[e]["water_max_m"].get<double>() > 0.02) ++wet;
            if (roads[e]["closed_to_traffic"].get<bool>()) {
                ++closed;
                closed_empty = closed_empty && after[e]["closed"].get<bool>();
            }
            if (after[e]["flood"].get<double>() > 0.01) ++flooded_state;
            if (after[e]["env_speed_multiplier"].get<double>() < 0.9) ++slowed;
        }
        std::cout << "      " << wet << " roads under water, " << slowed << " slowed, " << closed << " closed\n";
        check(wet > 0 && flooded_state > 0, "water deepens on roads at the bottom of the bowl and their state says flooded");
        check(slowed > 0, "water slows the traffic on them");
        check(closed > 0 && closed_empty, "roads deeper than a car can wade are closed in the traffic step");
        const auto env = run.engine->environment()["data"]["state"]["hydrology"];
        check(env["conservation_error_m3"].get<double>() == 0.0, "and the water is still exactly accounted for");
        // The legacy node flood model no longer acts: with the hydrology off it would.
        (void)run.engine->set_module("hydrology", false);
        (void)before;
    }

    if (failures) {
        std::cerr << failures << " vehicle check(s) failed\n";
        return 1;
    }
    std::cout << "vehicle tests passed\n";
    return 0;
}
