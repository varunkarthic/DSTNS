// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The environment at run time: the dynamic state of every environmental
// module, advanced by the engine's clock.
//
// One EnvironmentRuntime per world. It reads the immutable scenario (terrain,
// calendar, location) and owns everything that changes: solar forcing and
// surface temperature now, surface water, drainage and wind as those modules
// arrive. Its whole state is one copyable value, EnvironmentState, which the
// engine stores in every checkpoint, so restoring a checkpoint and replaying
// reaches exactly the state of continuous execution.
//
// Modules run at their own rates (multirate scheduling), each on a cadence
// that divides the 900 s checkpoint interval so a replay from any checkpoint
// meets the same update instants:
//
//     DCM: solar position, irradiance, surface energy    every 60 s
//     DWS: rain, surface water flow, sinks               every 5 s (CFL substeps)
//
// State produced at time t is read by other modules from the next step on
// (never recursively within one instant).

#include "dstns/compute/backend.hpp"
#include "dstns/compute/options.hpp"
#include "dstns/environment/drainage.hpp"
#include "dstns/environment/hydrology.hpp"
#include "dstns/environment/solar.hpp"
#include "dstns/environment/vehicles.hpp"
#include "dstns/environment/terrain.hpp"
#include "dstns/model.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace dstns::env {

/// One active storm cell, as the engine evaluates it each step.
struct StormCell {
    double x_m{}, y_m{}, radius_m{}, intensity{};
};

/// What the engine tells the environment about one step.
struct EnvironmentInputs {
    std::uint32_t virtual_s{};          // the time this step ends at
    std::vector<StormCell> storms;
    bool dcm{true};
    bool hydrology{true};
    bool drainage{true};
};

/// Where the environment's grid solvers may run. Grids of at least
/// `gpu_min_cells` use a Vulkan device when the compute preference allows one;
/// a preference for Vulkan uses it at any size; cpu never does.
///
/// Measured on an Apple M4 (dstns_benchmark hydrology, and full days on the
/// bundled district): with water on every cell the device wins from about
/// 4,000 cells, but a city's water is sparse, and the CPU's passes over dry
/// faces cost almost nothing while every device step pays ~0.8 ms to submit,
/// wait and read back. A full day on an 11,664-cell district took 29 s with
/// the CPU and 40 s with the device. Hence the default, about 360 x 360.
struct EnvironmentCompute {
    compute::ComputeOptions options;
    compute::LogSink log;
    std::uint32_t gpu_min_cells{131072};
};

/// Parameters of the representative urban surface. Generic ground and road
/// are treated as aged asphalt where nothing better is known.
struct SurfaceParameters {
    double albedo{0.12};                // aged asphalt 0.10-0.15
    double emissivity{0.93};
    double heat_capacity_j_m2k{1.05e5}; // 5 cm of asphalt, rho c = 2.1 MJ/m^3 K
    double ground_conductance_w_m2k{5.0}; // k / dz = 0.75 W/m K over 15 cm
    double convection_base_w_m2k{5.7};  // McAdams: h = 5.7 + 3.8 u
    double convection_wind_w_m3k{3.8};
    double background_wind_mps{3.0};    // until the atmosphere model provides wind
    double anthropogenic_w_m2{0.0};     // optional; uncalibrated, so off by default
};

struct SolarState {
    SolarPosition position;
    ClearSky clear;
    int representative_day{};
    double cloud_mean{};                // over the grid, 0..1
    double air_temperature_c{};         // background, at the grid centre
};

/// One directed road as the environment leaves it: the bridge between the
/// environmental models and traffic.
struct RoadEnvironment {
    double grade{};                  // rise over run, this direction
    double water_max_m{}, water_mean_m{};
    double flood_index{};            // 0 below 2 cm of water, 1 at a car's wading depth
    double surface_temperature_c{};
    double speed_multiplier{1}, capacity_multiplier{1};
    double grade_factor{1}, water_factor{1};
    bool closed{};                   // to the traffic stream (small passenger cars)
    std::array<bool, 4> passable{true, true, true, true}; // by VehicleClass
    double energy_kwh_per_km{};      // small passenger car at the road's speed
};

/// Everything that changes. Copyable: a checkpoint holds one of these.
struct EnvironmentState {
    std::uint32_t time_s{};             // the virtual second this state describes
    std::uint32_t dcm_time_s{};         // when the DCM last updated
    SolarState solar;
    std::vector<float> irradiance_w_m2;     // shortwave reaching each cell's surface
    std::vector<float> surface_temperature_c;
    std::vector<float> cloud_fraction;
    std::vector<float> evaporation_m_s;     // potential, from the surface energy state
    double air_temperature_anomaly_c{};
    HydrologyState water;
    DrainageState drains;
};

class EnvironmentRuntime {
public:
    static constexpr std::uint32_t kDcmIntervalS = 60;
    static constexpr std::uint32_t kHydrologyIntervalS = 5;

    void install(const Scenario& scenario, const SurfaceParameters& surface = {}, const HydrologyParams& hydrology = {},
                 const EnvironmentCompute* compute = nullptr, const DrainageParams& drainage = {});
    void release();
    [[nodiscard]] bool installed() const { return terrain_ != nullptr; }
    /// The state before the first step: midnight, surface temperatures from a
    /// one-day spin-up under clear sky.
    void reset();
    /// Advance to `inputs.virtual_s`, running each module whose instant has come.
    void step(const EnvironmentInputs& inputs);

    /// The complete state, fields included: a device-resident solver's
    /// fields are brought to the host first. For checkpoints and field reads.
    [[nodiscard]] const EnvironmentState& state() const;
    void restore(const EnvironmentState& state);
    [[nodiscard]] const Terrain& terrain() const { return *terrain_; }

    /// Summary for the API and reports.
    [[nodiscard]] nlohmann::json summary() const;
    /// Names of the fields available now, with units.
    [[nodiscard]] std::vector<std::pair<std::string, std::string>> fields() const;
    /// A field by name, on the environment grid; nullptr if unknown.
    [[nodiscard]] const std::vector<float>* field(const std::string& name) const;

    /// Background air temperature at a solar time, deg C, for the run's place and month.
    [[nodiscard]] double air_temperature(double solar_time_h) const;

    /// The surface water model's static grid and parameters.
    [[nodiscard]] const HydrologyGrid& hydrology_grid() const { return hydrology_grid_; }
    [[nodiscard]] const HydrologyParams& hydrology_params() const { return hydrology_; }
    [[nodiscard]] const DrainageNetwork& drainage() const { return drainage_; }
    /// The drains' state; always on the host, so reading it costs nothing.
    [[nodiscard]] const DrainageState& drainage_state() const { return state_.drains; }
    [[nodiscard]] const DrainageParams& drainage_params() const { return drainage_params_; }
    /// What the environment does to directed edge `e` now. `full` adds the
    /// figures only views need (surface temperature, energy).
    [[nodiscard]] RoadEnvironment road(std::size_t e, bool full = false) const;
    [[nodiscard]] std::size_t roads() const { return grade_factor_.size(); }
    /// Changes whenever what road() returns may have changed (a water step, a
    /// restored checkpoint, a new world), so callers can skip unchanged work.
    [[nodiscard]] std::uint64_t road_revision() const { return road_revision_; }
    /// Rainfall rate at a point now, mm/h.
    [[nodiscard]] double rain_rate_mm_h(double x_m, double y_m, const std::vector<StormCell>& storms) const;

private:
    void update_dcm(std::uint32_t virtual_s, const std::vector<StormCell>& storms, double dt_s);
    void cloud_field(const std::vector<StormCell>& storms);
    void update_hydrology(std::uint32_t virtual_s, const std::vector<StormCell>& storms, bool drainage);
    void refresh_water_field() const;
    void sync_water() const;

    std::shared_ptr<const Terrain> terrain_;
    SurfaceParameters surface_;
    double latitude_{}, longitude_{};
    int month_{1}, day_of_year_{15};
    Climate climate_;
    double anomaly_c_{};
    std::vector<float> cos_slope_;      // cosine of each cell's tilt
    std::vector<float> normal_x_, normal_y_, normal_z_;
    // The representative day's sun path, every 15 minutes: (clock s, elevation, azimuth).
    std::vector<std::array<double, 3>> sun_path_;
    HydrologyParams hydrology_;
    DrainageParams drainage_params_;
    DrainageNetwork drainage_;
    // Per directed edge, fixed for the world: grade, the aggregate stream's
    // speed factor on it, its free speed and midpoint.
    std::vector<double> edge_grade_, grade_factor_, free_speed_;
    std::vector<std::pair<double, double>> edge_mid_;
    HydrologyGrid hydrology_grid_;
    std::unique_ptr<HydrologySolver> hydrology_solver_;
    // h in metres for fields, rebuilt on demand. With a device-resident
    // solver the host's h, qx, qy go stale after a step until synced.
    mutable std::vector<float> water_depth_m_;
    mutable bool water_stale_{}, depth_stale_{};
    std::uint64_t road_revision_{1};
    mutable EnvironmentState state_;
    EnvironmentState initial_;
};

} // namespace dstns::env
