// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Vehicle dynamics: how a road's grade, the wind along it and the water on it
// change what traffic can do there. Not "uphill: speed x 0.9", but the force a
// vehicle needs,
//
//   F_t = m a + m g sin(theta) + C_rr m g cos(theta) + 1/2 rho C_d A (v - v_w)^2,
//
// and the power it is prepared to spend, P = F_t v. Drivers are taken to be
// economical: each class cruises within a power budget well below its engine's
// maximum, and never above the road's limit. A slope steep enough that the
// budget cannot hold the limit slows that class; a downhill never speeds it up.
//
// Standing water follows Pregnolato et al. (2017), a depth-disruption function
// fitted to observations and experiments:
//
//   v(w) = 0.0009 w^2 - 0.5529 w + 86.9448   km/h, w the depth in mm,
//
// a car being stopped at 300 mm. The ratio v(w)/v(0) scales a road's speed and
// capacity; each class has its own depth beyond which it cannot pass.

#include <array>
#include <cstdint>
#include <string>

namespace dstns::env {

enum class VehicleClass : std::uint8_t { SmallPassenger, LargePassenger, Bus, Emergency };
inline constexpr std::array<VehicleClass, 4> kVehicleClasses{VehicleClass::SmallPassenger, VehicleClass::LargePassenger,
                                                             VehicleClass::Bus, VehicleClass::Emergency};

/// Representative parameters of a class. Generic, not any manufacturer's.
struct VehicleParams {
    const char* name;
    double mass_kg;
    double drag_area_m2;         // C_d A
    double rolling_coefficient;  // C_rr
    double cruise_power_w;       // the economical power budget at steady speed
    double wading_depth_m;       // deeper water stops this class
    double traffic_share;        // its share of the aggregate traffic stream
};

[[nodiscard]] const VehicleParams& vehicle_params(VehicleClass vehicle);
[[nodiscard]] const char* to_string(VehicleClass vehicle);

inline constexpr double kGravityMps2 = 9.81;
inline constexpr double kSeaLevelAirDensity = 1.225;  // kg/m^3

/// Tractive force, N, at speed v (m/s) on grade g (rise over run), with a
/// headwind component (positive against the vehicle) and acceleration a.
[[nodiscard]] double tractive_force(const VehicleParams& p, double v, double grade, double headwind_mps, double accel_mps2 = 0,
                                    double air_density = kSeaLevelAirDensity);

/// The steady speed at which P = F_t v uses the class's power budget, capped
/// at `limit_mps`. Bisection on the monotonic power curve; a downhill whose
/// gravity exceeds the resistances returns the cap.
[[nodiscard]] double power_limited_speed(const VehicleParams& p, double grade, double headwind_mps, double limit_mps,
                                         double air_density = kSeaLevelAirDensity);

/// Energy at the wheels per kilometre, kWh, cruising at v. Braking energy is
/// not recovered: a negative force costs nothing and returns nothing.
[[nodiscard]] double energy_kwh_per_km(const VehicleParams& p, double v, double grade, double headwind_mps,
                                       double air_density = kSeaLevelAirDensity);

/// Pregnolato et al. (2017): v(w)/v(0), in [0, 1], for water w metres deep.
[[nodiscard]] double water_speed_factor(double depth_m);

/// The aggregate stream's speed multiplier from grade and wind: each class's
/// power-limited speed relative to its own on a flat, still road, weighted by
/// its share. Exactly 1 on flat ground in still air.
[[nodiscard]] double grade_speed_factor(double grade, double headwind_mps, double limit_mps);

} // namespace dstns::env
