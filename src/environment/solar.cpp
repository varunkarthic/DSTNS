// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/solar.hpp"

#include <algorithm>
#include <array>
#include <cmath>

namespace dstns::env {
namespace {
constexpr double kPi = 3.141592653589793;
constexpr double rad(double d) { return d * kPi / 180.0; }
constexpr double deg(double r) { return r * 180.0 / kPi; }
// Klein (1977), "Calculation of monthly average insolation on tilted
// surfaces", Table 1: the day of the year whose extraterrestrial radiation is
// closest to the month's mean.
constexpr std::array<int, 12> kKleinDays{17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344};
constexpr double kSolarConstant = 1361.0;  // W/m^2 (Kopp and Lean 2011)
} // namespace

int representative_day(int month) { return kKleinDays.at(std::size_t(std::clamp(month, 1, 12) - 1)); }

SolarPosition solar_position(double latitude, double longitude, int n, double clock_s) {
    SolarPosition p;
    // Cooper (1969) declination.
    p.declination_deg = 23.45 * std::sin(rad(360.0 / 365.0 * (284 + n)));
    // Equation of time (Spencer 1971 as given by Duffie and Beckman), minutes.
    const double b = rad(360.0 * (n - 81) / 364.0);
    p.equation_of_time_min = 9.87 * std::sin(2 * b) - 7.53 * std::cos(b) - 1.5 * std::sin(b);
    // Standard time on the nominal meridian, to solar time: 4 minutes per
    // degree of longitude east of the meridian, plus the equation of time.
    const double meridian = 15.0 * std::round(longitude / 15.0);
    p.solar_time_h = clock_s / 3600.0 + (4.0 * (longitude - meridian) + p.equation_of_time_min) / 60.0;
    p.hour_angle_deg = 15.0 * (p.solar_time_h - 12.0);
    const double phi = rad(latitude), delta = rad(p.declination_deg), h = rad(p.hour_angle_deg);
    const double sin_alpha = std::sin(phi) * std::sin(delta) + std::cos(phi) * std::cos(delta) * std::cos(h);
    p.elevation_deg = deg(std::asin(std::clamp(sin_alpha, -1.0, 1.0)));
    p.zenith_deg = 90.0 - p.elevation_deg;
    // Azimuth clockwise from north, quadrant-aware through atan2: east of the
    // meridian before noon (h < 0), west after.
    const double az = std::atan2(-std::sin(h) * std::cos(delta),
                                 std::cos(phi) * std::sin(delta) - std::sin(phi) * std::cos(delta) * std::cos(h));
    p.azimuth_deg = std::fmod(deg(az) + 360.0, 360.0);
    p.daylight = p.elevation_deg > 0;
    return p;
}

ClearSky clear_sky(double zenith_deg, int n) {
    ClearSky s;
    s.extraterrestrial = kSolarConstant * (1.0 + 0.033 * std::cos(rad(360.0 * n / 365.0)));
    if (zenith_deg >= 90.0) return s;
    // Kasten and Young (1989) relative air mass.
    s.air_mass = 1.0 / (std::cos(rad(zenith_deg)) + 0.50572 * std::pow(96.07995 - zenith_deg, -1.6364));
    // Meinel and Meinel (1976) beam transmittance.
    s.transmittance = std::pow(0.7, std::pow(s.air_mass, 0.678));
    s.direct_normal = s.extraterrestrial * s.transmittance;
    // Diffuse sky radiation as a tenth of the beam (Laue 1970), on the horizontal.
    s.diffuse_horizontal = 0.1 * s.direct_normal;
    s.global_horizontal = s.direct_normal * std::cos(rad(zenith_deg)) + s.diffuse_horizontal;
    return s;
}

double cloud_transmission(double c) { return 1.0 - 0.75 * std::pow(std::clamp(c, 0.0, 1.0), 3.4); }

Climate zonal_climate(double latitude, int month) {
    const double lat = std::abs(latitude);
    const double c = std::cos(rad(latitude));
    const int peak = latitude >= 0 ? 7 : 1;
    Climate k;
    k.monthly_mean_c = 29.0 * c * c + 0.18 * lat * std::cos(2 * kPi * (std::clamp(month, 1, 12) - peak) / 12.0);
    // Mid-latitude and subtropical land: 8 to 12 degrees between night and day.
    k.diurnal_range_c = 10.0;
    return k;
}

double diurnal_air_temperature(const Climate& k, double solar_time_h, double anomaly_c) {
    return k.monthly_mean_c + anomaly_c + 0.5 * k.diurnal_range_c * std::cos(2 * kPi * (solar_time_h - 15.0) / 24.0);
}

} // namespace dstns::env
