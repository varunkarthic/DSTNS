// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// DCM: the deterministic cosmic model. In scope: the Sun as the city's energy
// source, nothing more.
//
// A run has a month but no day of the month, so the Sun follows the month's
// *representative day*: Klein's (1977) mean days, the day whose
// extraterrestrial radiation equals the month's mean (January 17, February
// 16, ..., December 10). It is an internal approximation for solar geometry,
// never shown as a date.
//
// The simulation clock is taken to be local *standard* time on the nominal
// meridian of the city's longitude (15 degrees per hour, no daylight saving),
// and corrected to solar time with the equation of time. All angles here are
// degrees; irradiances are W/m^2.

#include <cstdint>

namespace dstns::env {

/// Klein's representative day of the year for a month (1..12).
[[nodiscard]] int representative_day(int month);

struct SolarPosition {
    double declination_deg{};
    double equation_of_time_min{};
    double solar_time_h{};
    double hour_angle_deg{};
    double elevation_deg{};     // above the horizon; negative below
    double azimuth_deg{};       // clockwise from north, [0, 360)
    double zenith_deg{};
    bool daylight{};
};

/// Where the Sun is at `clock_s` seconds after local standard midnight.
[[nodiscard]] SolarPosition solar_position(double latitude, double longitude, int day_of_year, double clock_s);

struct ClearSky {
    double extraterrestrial{};  // I0, normal to the beam, top of atmosphere
    double air_mass{};
    double transmittance{};     // T_atm of the beam
    double direct_normal{};     // DNI at the surface, clear sky
    double diffuse_horizontal{};
    double global_horizontal{};
};

/// Clear-sky irradiance for a solar zenith angle: Kasten-Young air mass,
/// Meinel beam transmittance T = 0.7^(AM^0.678), diffuse a fixed fraction of
/// the beam (Laue). Zero below the horizon.
[[nodiscard]] ClearSky clear_sky(double zenith_deg, int day_of_year);

/// Kasten and Czeplak (1980): the share of clear-sky global irradiance that
/// survives cloud cover c in [0, 1], 1 - 0.75 c^3.4.
[[nodiscard]] double cloud_transmission(double cloud_fraction);

/// Background near-surface climate for a latitude and month: a zonal
/// approximation, not a climatology. Mean air temperature
///   T = 29 cos^2(lat) + 0.18 |lat| cos(2 pi (m - m_peak) / 12)  (deg C),
/// with m_peak July in the northern hemisphere and January in the southern,
/// and a diurnal swing of `diurnal_range_c` peaking at 15:00 solar time.
struct Climate {
    double monthly_mean_c{};
    double diurnal_range_c{};
};
[[nodiscard]] Climate zonal_climate(double latitude, int month);
/// Air temperature at a solar time of day, deg C: a cosine with its minimum
/// at 03:00 and maximum at 15:00, about the monthly mean.
[[nodiscard]] double diurnal_air_temperature(const Climate& climate, double solar_time_h, double anomaly_c);

} // namespace dstns::env
