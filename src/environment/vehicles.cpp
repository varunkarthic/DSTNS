// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/vehicles.hpp"

#include <algorithm>
#include <cmath>

namespace dstns::env {
namespace {
// Representative classes. Masses, frontal areas and rolling coefficients are
// typical published values for each class; the power budgets are economical
// cruising, a third to a half of rated power. Wading depths: 300 mm for a car
// is where Pregnolato et al.'s function reaches a standstill; larger
// vehicles' are configuration-level assumptions, stated in the documentation.
constexpr std::array<VehicleParams, 4> kParams{{
    {"small passenger", 1300, 0.62, 0.012, 25000, 0.30, 0.62},
    {"large passenger", 2100, 0.95, 0.012, 35000, 0.40, 0.30},
    {"bus", 12000, 6.0, 0.008, 120000, 0.50, 0.08},
    {"emergency", 3500, 2.2, 0.012, 60000, 0.45, 0.00},
}};
} // namespace

const VehicleParams& vehicle_params(VehicleClass v) { return kParams[std::size_t(v)]; }
const char* to_string(VehicleClass v) { return kParams[std::size_t(v)].name; }

double tractive_force(const VehicleParams& p, double v, double grade, double headwind, double accel, double rho) {
    const double theta = std::atan(grade);
    const double air = v + headwind;
    return p.mass_kg * accel + p.mass_kg * kGravityMps2 * std::sin(theta) + p.rolling_coefficient * p.mass_kg * kGravityMps2 * std::cos(theta) +
           0.5 * rho * p.drag_area_m2 * air * std::abs(air);
}

double power_limited_speed(const VehicleParams& p, double grade, double headwind, double limit, double rho) {
    const auto power = [&](double v) { return tractive_force(p, v, grade, headwind, 0, rho) * v; };
    if (limit <= 0) return 0;
    if (power(limit) <= p.cruise_power_w) return limit;
    // P(v) is increasing wherever it matters (F_t > 0), so bisect for P(v) = budget.
    double lo = 0, hi = limit;
    for (int i = 0; i < 48; ++i) {
        const double mid = 0.5 * (lo + hi);
        (power(mid) <= p.cruise_power_w ? lo : hi) = mid;
    }
    return lo;
}

double energy_kwh_per_km(const VehicleParams& p, double v, double grade, double headwind, double rho) {
    return std::max(0.0, tractive_force(p, v, grade, headwind, 0, rho)) * 1000.0 / 3.6e6;
}

double water_speed_factor(double depth_m) {
    const double w = std::clamp(depth_m * 1000.0, 0.0, 300.0);
    const double v = 0.0009 * w * w - 0.5529 * w + 86.9448;
    return depth_m * 1000.0 >= 300.0 ? 0.0 : std::clamp(v / 86.9448, 0.0, 1.0);
}

double grade_speed_factor(double grade, double headwind, double limit) {
    if (limit <= 0) return 1;
    double sum = 0, shares = 0;
    for (const auto c : kVehicleClasses) {
        const auto& p = vehicle_params(c);
        if (p.traffic_share <= 0) continue;
        const double flat = power_limited_speed(p, 0, 0, limit);
        const double here = power_limited_speed(p, grade, headwind, limit);
        sum += p.traffic_share * (flat > 0 ? std::min(1.0, here / flat) : 1.0);
        shares += p.traffic_share;
    }
    // Exactly 1 on the flat in still air: every term is flat / flat.
    return shares > 0 ? sum / shares : 1.0;
}

} // namespace dstns::env
