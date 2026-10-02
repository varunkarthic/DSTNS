// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/runtime.hpp"

#include "dstns/rng.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace dstns::env {
namespace {
constexpr double kPi = 3.141592653589793;
constexpr double kStefanBoltzmann = 5.670374419e-8;  // W/m^2 K^4
constexpr double kKelvin = 273.15;
// Cloud extends beyond the rain it drops: a storm's cloud shield is taken to
// be this many times the radius of its rain cell.
constexpr double kCloudShieldFactor = 1.8;
// Air under a storm's cloud is cooler than the open-sky background, by up to this much.
constexpr double kCloudCoolingC = 3.0;

double wendland(double d, double r) {
    if (r <= 0 || d >= r) return 0;
    const double q = d / r, t = 1 - q;
    return t * t * t * t * (1 + 4 * q);
}

/// A standard normal draw from two uniforms (Box-Muller), deterministic.
double normal(const DeterministicRng& rng, std::uint64_t object) {
    const double u1 = rng.uniform01({RngDomain::Atmosphere, object, 0, 0});
    const double u2 = rng.uniform01({RngDomain::Atmosphere, object, 1, 0});
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(2 * kPi * u2);
}
} // namespace

void EnvironmentRuntime::install(const Scenario& scenario, const SurfaceParameters& surface) {
    terrain_ = scenario.terrain;
    if (!terrain_) {
        // A scenario built without terrain (tests that assemble one by hand)
        // still gets a flat grid, so every module has somewhere to live.
        auto flat = std::make_shared<Terrain>();
        flat->grid = environment_grid(scenario, scenario.config.environment);
        flat->projection = scenario_projection(scenario);
        flat->elevation_m.assign(flat->grid.cells(), 0);
        compute_gradient(*flat);
        terrain_ = flat;
    }
    surface_ = surface;
    const auto& g = terrain_->grid;
    std::tie(latitude_, longitude_) = terrain_->projection.to_geo(g.origin_x_m + g.width * g.cell_m / 2, g.origin_y_m + g.height * g.cell_m / 2);
    month_ = scenario.month;
    day_of_year_ = representative_day(month_);
    climate_ = zonal_climate(latitude_, month_);
    // The day's departure from the month's mean: one draw from the run's own
    // atmosphere stream, about 1.5 degrees either way.
    anomaly_c_ = 1.5 * normal(DeterministicRng(scenario.seed.derive("das.climate")), 0);

    // Unit surface normals from the terrain gradient: n = (-dz/dx, -dz/dy, 1) / |.|.
    const auto cells = g.cells();
    normal_x_.resize(cells);
    normal_y_.resize(cells);
    normal_z_.resize(cells);
    cos_slope_.resize(cells);
    for (std::size_t k = 0; k < cells; ++k) {
        const double gx = terrain_->dzdx.empty() ? 0 : terrain_->dzdx[k], gy = terrain_->dzdy.empty() ? 0 : terrain_->dzdy[k];
        const double norm = std::sqrt(gx * gx + gy * gy + 1);
        normal_x_[k] = static_cast<float>(-gx / norm);
        normal_y_[k] = static_cast<float>(-gy / norm);
        normal_z_[k] = static_cast<float>(1 / norm);
        cos_slope_[k] = normal_z_[k];
    }

    // Spin-up: two clear days, so midnight surface temperatures are those of
    // the periodic diurnal cycle rather than an arbitrary guess.
    state_ = {};
    state_.irradiance_w_m2.assign(cells, 0);
    state_.cloud_fraction.assign(cells, 0);
    const double start = air_temperature(solar_position(latitude_, longitude_, day_of_year_, 0).solar_time_h);
    state_.surface_temperature_c.assign(cells, static_cast<float>(start));
    state_.air_temperature_anomaly_c = anomaly_c_;
    // Ten-minute steps: explicit Euler stays stable for steps under twice the
    // slab's 40-minute time constant, and the spin-up costs a tenth as much.
    constexpr std::uint32_t kSpinUpStepS = 600;
    for (int day = 0; day < 2; ++day)
        for (std::uint32_t t = kSpinUpStepS; t <= 86400; t += kSpinUpStepS) update_dcm(t, {}, kSpinUpStepS);
    std::fill(state_.irradiance_w_m2.begin(), state_.irradiance_w_m2.end(), 0.0f);
    state_.time_s = 0;
    state_.dcm_time_s = 0;
    // The state at 00:00:00 describes midnight's Sun, not the spin-up's last minute.
    state_.solar.position = solar_position(latitude_, longitude_, day_of_year_, 0);
    state_.solar.clear = clear_sky(state_.solar.position.zenith_deg, day_of_year_);
    state_.solar.representative_day = day_of_year_;
    state_.solar.air_temperature_c = air_temperature(state_.solar.position.solar_time_h);
    initial_ = state_;
}

void EnvironmentRuntime::release() {
    terrain_.reset();
    state_ = {};
    initial_ = {};
}

void EnvironmentRuntime::reset() { state_ = initial_; }

double EnvironmentRuntime::air_temperature(double solar_time_h) const {
    return diurnal_air_temperature(climate_, solar_time_h, anomaly_c_);
}

void EnvironmentRuntime::cloud_field(const std::vector<StormCell>& storms) {
    const auto& g = terrain_->grid;
    auto& cloud = state_.cloud_fraction;
    if (storms.empty()) {
        std::fill(cloud.begin(), cloud.end(), 0.0f);
        return;
    }
    // Overlapping cloud shields combine as independent cover: c = 1 - prod(1 - c_k).
    for (std::uint32_t j = 0; j < g.height; ++j)
        for (std::uint32_t i = 0; i < g.width; ++i) {
            double clear = 1;
            for (const auto& s : storms) {
                const double d = std::hypot(g.centre_x(i) - s.x_m, g.centre_y(j) - s.y_m);
                const double cover = std::min(1.0, 0.6 + 0.4 * s.intensity) * wendland(d, kCloudShieldFactor * s.radius_m);
                clear *= 1 - cover;
            }
            cloud[g.index(i, j)] = static_cast<float>(1 - clear);
        }
}

void EnvironmentRuntime::update_dcm(std::uint32_t t, const std::vector<StormCell>& storms, double dt) {
    const auto pos = solar_position(latitude_, longitude_, day_of_year_, t);
    const auto sky = clear_sky(pos.zenith_deg, day_of_year_);
    cloud_field(storms);
    const double el = pos.elevation_deg * kPi / 180, az = pos.azimuth_deg * kPi / 180;
    // Unit vector towards the Sun: x east, y north, z up.
    const double sx = std::sin(az) * std::cos(el), sy = std::cos(az) * std::cos(el), sz = std::sin(el);
    const double open_air = air_temperature(pos.solar_time_h);
    const double deep_c = climate_.monthly_mean_c + anomaly_c_ + 2.0;  // the slab beneath, near the monthly mean
    const auto& p = surface_;
    const double h_conv = p.convection_base_w_m2k + p.convection_wind_w_m3k * p.background_wind_mps;
    const auto cells = state_.surface_temperature_c.size();
    double cloud_sum = 0;
    for (std::size_t k = 0; k < cells; ++k) {
        const double c = state_.cloud_fraction[k];
        cloud_sum += c;
        const double tr = cloud_transmission(c);
        const double incidence = pos.daylight ? std::max(0.0, normal_x_[k] * sx + normal_y_[k] * sy + normal_z_[k] * sz) : 0.0;
        // Beam on the tilted cell, plus isotropic sky diffuse seen by its tilt.
        const double shortwave = tr * (sky.direct_normal * incidence + sky.diffuse_horizontal * (1 + cos_slope_[k]) / 2);
        state_.irradiance_w_m2[k] = static_cast<float>(shortwave);

        const double ta = open_air - kCloudCoolingC * c;
        const double ta_k = ta + kKelvin;
        // Swinbank (1963) clear-sky emissivity, raised by cloud (1 + 0.22 c^2).
        const double ta_k2 = ta_k * ta_k;
        const double sky_lw = 9.365e-6 * ta_k2 * kStefanBoltzmann * ta_k2 * ta_k2 * (1 + 0.22 * c * c);
        // Explicit Euler: the slab's time constant C / (4 eps sigma T^3 + h + U)
        // is about 40 minutes, so steps of up to 10 minutes are stable.
        double ts = state_.surface_temperature_c[k];
        const int substeps = std::max(1, int(std::ceil(dt / 600.0)));
        const double h = dt / substeps;
        for (int n = 0; n < substeps; ++n) {
            const double ts_k = ts + kKelvin, ts_k2 = ts_k * ts_k;
            const double net = (1 - p.albedo) * shortwave + p.emissivity * sky_lw - p.emissivity * kStefanBoltzmann * ts_k2 * ts_k2 -
                               h_conv * (ts - ta) - p.ground_conductance_w_m2k * (ts - deep_c) + p.anthropogenic_w_m2;
            ts += h * net / p.heat_capacity_j_m2k;
        }
        state_.surface_temperature_c[k] = static_cast<float>(ts);
    }
    state_.solar.position = pos;
    state_.solar.clear = sky;
    state_.solar.representative_day = day_of_year_;
    state_.solar.cloud_mean = cells ? cloud_sum / double(cells) : 0;
    state_.solar.air_temperature_c = open_air;
    state_.dcm_time_s = t;
}

void EnvironmentRuntime::step(const EnvironmentInputs& in) {
    if (!terrain_) return;
    const auto t = in.virtual_s;
    if (in.dcm && t >= state_.dcm_time_s + kDcmIntervalS && t % kDcmIntervalS == 0)
        update_dcm(t, in.storms, double(t - state_.dcm_time_s));
    else if (!in.dcm && t % kDcmIntervalS == 0)
        state_.dcm_time_s = t;  // a disabled module holds its state; it does not catch up later
    state_.time_s = t;
}

std::vector<std::pair<std::string, std::string>> EnvironmentRuntime::fields() const {
    if (!terrain_) return {};
    return {{"elevation", "m"}, {"slope", "m/m"}, {"irradiance", "W/m²"}, {"surface_temperature", "°C"}, {"cloud", "fraction"}};
}

const std::vector<float>* EnvironmentRuntime::field(const std::string& name) const {
    if (!terrain_) return nullptr;
    if (name == "elevation") return &terrain_->elevation_m;
    if (name == "slope") return &terrain_->slope;
    if (name == "irradiance") return &state_.irradiance_w_m2;
    if (name == "surface_temperature") return &state_.surface_temperature_c;
    if (name == "cloud") return &state_.cloud_fraction;
    return nullptr;
}

nlohmann::json EnvironmentRuntime::summary() const {
    if (!terrain_) return nullptr;
    const auto& s = state_.solar;
    const auto stats = [](const std::vector<float>& v) {
        if (v.empty()) return nlohmann::json(nullptr);
        const auto [lo, hi] = std::minmax_element(v.begin(), v.end());
        const double mean = std::accumulate(v.begin(), v.end(), 0.0) / double(v.size());
        return nlohmann::json{{"min", *lo}, {"mean", mean}, {"max", *hi}};
    };
    return {
        {"time_s", state_.time_s},
        {"dcm", {
            {"updated_s", state_.dcm_time_s},
            {"interval_s", kDcmIntervalS},
            {"representative_day_of_year", s.representative_day},
            {"latitude", latitude_}, {"longitude", longitude_},
            {"solar_time_h", s.position.solar_time_h},
            {"declination_deg", s.position.declination_deg},
            {"equation_of_time_min", s.position.equation_of_time_min},
            {"elevation_deg", s.position.elevation_deg},
            {"azimuth_deg", s.position.azimuth_deg},
            {"daylight", s.position.daylight},
            {"extraterrestrial_w_m2", s.clear.extraterrestrial},
            {"direct_normal_w_m2", s.clear.direct_normal * cloud_transmission(s.cloud_mean)},
            {"diffuse_horizontal_w_m2", s.clear.diffuse_horizontal * cloud_transmission(s.cloud_mean)},
            {"clear_sky_global_horizontal_w_m2", s.clear.global_horizontal},
            {"cloud_mean", s.cloud_mean},
            {"air_temperature_c", s.air_temperature_c},
            {"air_temperature_anomaly_c", anomaly_c_},
            {"monthly_mean_air_c", climate_.monthly_mean_c},
            {"irradiance_w_m2", stats(state_.irradiance_w_m2)},
            {"surface_temperature_c", stats(state_.surface_temperature_c)},
            {"surface", {{"class", "asphalt (assumed everywhere)"}, {"albedo", surface_.albedo}, {"emissivity", surface_.emissivity},
                         {"heat_capacity_j_m2k", surface_.heat_capacity_j_m2k}}}
        }}
    };
}

} // namespace dstns::env
