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
//
// State produced at time t is read by other modules from the next step on
// (never recursively within one instant).

#include "dstns/environment/solar.hpp"
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

/// Everything that changes. Copyable: a checkpoint holds one of these.
struct EnvironmentState {
    std::uint32_t time_s{};             // the virtual second this state describes
    std::uint32_t dcm_time_s{};         // when the DCM last updated
    SolarState solar;
    std::vector<float> irradiance_w_m2;     // shortwave reaching each cell's surface
    std::vector<float> surface_temperature_c;
    std::vector<float> cloud_fraction;
    double air_temperature_anomaly_c{};
};

class EnvironmentRuntime {
public:
    static constexpr std::uint32_t kDcmIntervalS = 60;

    void install(const Scenario& scenario, const SurfaceParameters& surface = {});
    void release();
    [[nodiscard]] bool installed() const { return terrain_ != nullptr; }
    /// The state before the first step: midnight, surface temperatures from a
    /// one-day spin-up under clear sky.
    void reset();
    /// Advance to `inputs.virtual_s`, running each module whose instant has come.
    void step(const EnvironmentInputs& inputs);

    [[nodiscard]] const EnvironmentState& state() const { return state_; }
    void restore(const EnvironmentState& state) { state_ = state; }
    [[nodiscard]] const Terrain& terrain() const { return *terrain_; }

    /// Summary for the API and reports.
    [[nodiscard]] nlohmann::json summary() const;
    /// Names of the fields available now, with units.
    [[nodiscard]] std::vector<std::pair<std::string, std::string>> fields() const;
    /// A field by name, on the environment grid; nullptr if unknown.
    [[nodiscard]] const std::vector<float>* field(const std::string& name) const;

    /// Background air temperature at a solar time, deg C, for the run's place and month.
    [[nodiscard]] double air_temperature(double solar_time_h) const;

private:
    void update_dcm(std::uint32_t virtual_s, const std::vector<StormCell>& storms, double dt_s);
    void cloud_field(const std::vector<StormCell>& storms);

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
    EnvironmentState state_;
    EnvironmentState initial_;
};

} // namespace dstns::env
