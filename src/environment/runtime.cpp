// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/runtime.hpp"

#include "dstns/compute/dispatcher.hpp"
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
constexpr double kAirDensity = 1.2;          // kg/m^3
constexpr double kWaterDensity = 1000.0;     // kg/m^3
constexpr double kLatentHeat = 2.45e6;       // J/kg, vaporisation near 20 C
constexpr double kWetFilmM = 0.0005;         // a film this deep wets a surface fully
constexpr double kPressurePa = 101325.0;

/// Saturation specific humidity at a temperature (deg C): Tetens' vapour
/// pressure, e_s = 610.94 exp(17.625 T / (T + 243.04)) Pa, as 0.622 e_s / p.
double saturation_humidity(double t_c) {
    const double es = 610.94 * std::exp(17.625 * t_c / (t_c + 243.04));
    return 0.622 * es / kPressurePa;
}

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

void EnvironmentRuntime::install(const Scenario& scenario, const SurfaceParameters& surface, const HydrologyParams& hydrology,
                                 const EnvironmentCompute* compute, const DrainageParams& drainage) {
    drainage_params_ = drainage;
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
    hydrology_ = hydrology;
    // The hydrology step must divide the checkpoint interval, so replay meets
    // the same instants.
    const auto interval = std::max<std::uint32_t>(1, std::uint32_t(std::lround(hydrology_.interval_s)));
    hydrology_.interval_s = 900 % interval == 0 ? interval : kHydrologyIntervalS;
    hydrology_grid_ = build_hydrology_grid(scenario, *terrain_, hydrology_);
    hydrology_solver_.reset();
    if (compute && compute->options.backend != compute::BackendPreference::Cpu && compute->options.allow_vulkan &&
        (hydrology_grid_.cells() >= compute->gpu_min_cells || compute->options.backend == compute::BackendPreference::Vulkan)) {
        std::string reason;
        hydrology_solver_ = make_vulkan_hydrology_solver(compute->options, compute->log, reason);
        if (hydrology_solver_) {
            try {
                hydrology_solver_->install(hydrology_grid_);
            } catch (const std::exception& e) {
                reason = e.what();
                hydrology_solver_.reset();
            }
        }
        if (compute->log)
            compute->log(hydrology_solver_ ? "INFO" : "WARN",
                         hydrology_solver_ ? "hydrology.backend vulkan for " + std::to_string(hydrology_grid_.cells()) + " cells"
                                           : "hydrology.backend cpu: Vulkan unavailable (" + reason + ")");
    }
    if (!hydrology_solver_) {
        hydrology_solver_ = make_cpu_hydrology_solver();
        hydrology_solver_->install(hydrology_grid_);
    }
    drainage_ = build_drainage(scenario, *terrain_, hydrology_grid_, drainage_params_);
    ++road_revision_;
    edge_grade_.clear();
    grade_factor_.clear();
    free_speed_.clear();
    edge_mid_.clear();
    for (const auto& e : scenario.edges) {
        edge_grade_.push_back(e.grade);
        grade_factor_.push_back(grade_speed_factor(e.grade, 0, e.free_speed_mps));
        free_speed_.push_back(e.free_speed_mps);
        const auto& a = scenario.nodes[e.from.value].position;
        const auto& b = scenario.nodes[e.to.value].position;
        edge_mid_.push_back({(a.x_m + b.x_m) / 2, (a.y_m + b.y_m) / 2});
    }
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

    sun_path_.clear();
    for (std::uint32_t t = 0; t <= 86400; t += 900) {
        const auto p = solar_position(latitude_, longitude_, day_of_year_, t);
        sun_path_.push_back({double(t), p.elevation_deg, p.azimuth_deg});
    }

    // Spin-up: two clear days, so midnight surface temperatures are those of
    // the periodic diurnal cycle rather than an arbitrary guess.
    state_ = {};
    state_.irradiance_w_m2.assign(cells, 0);
    state_.cloud_fraction.assign(cells, 0);
    state_.evaporation_m_s.assign(cells, 0);
    state_.water = initial_hydrology(hydrology_grid_);
    state_.drains = initial_drainage(drainage_);
    water_depth_m_.assign(cells, 0);
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
    hydrology_solver_->upload(state_.water);
}

void EnvironmentRuntime::release() {
    hydrology_solver_.reset();
    hydrology_grid_ = {};
    terrain_.reset();
    state_ = {};
    initial_ = {};
    water_depth_m_.clear();
}

void EnvironmentRuntime::reset() { restore(initial_); }

void EnvironmentRuntime::restore(const EnvironmentState& state) {
    state_ = state;
    ++road_revision_;
    if (hydrology_solver_) hydrology_solver_->upload(state_.water);
    water_stale_ = false;
    depth_stale_ = true;
}

const EnvironmentState& EnvironmentRuntime::state() const {
    sync_water();
    return state_;
}

void EnvironmentRuntime::sync_water() const {
    if (!water_stale_ || !hydrology_solver_) return;
    hydrology_solver_->download(state_.water);
    water_stale_ = false;
    depth_stale_ = true;
}

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
    // Wet surfaces cool by evaporation, so the energy balance reads the
    // current depths: bring a device-resident solver's fields over first.
    // Any water at all, not just "wet" cells: a sub-millimetre film still
    // cools the surface, and both backends must see the same film.
    if (state_.water.stored > 0) sync_water();
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
    const auto& water = state_.water.h;
    const double wind = p.background_wind_mps;
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
        // Evaporation from a wet surface (bulk aerodynamic formula):
        //   E = rho_a C_E u (q_sat(T_s) - RH q_sat(T_a)) / rho_w   [m/s],
        // with the humidity of the air rising under storm cloud. It is a
        // potential: the hydrology removes no more than is there. The latent
        // heat it takes cools the surface, in proportion to how wet it is.
        const double rh = std::min(0.98, hydrology_.relative_humidity + (0.98 - hydrology_.relative_humidity) * c);
        const double potential = std::max(0.0, kAirDensity * hydrology_.evaporation_coefficient * wind *
                                                   (saturation_humidity(ts) - rh * saturation_humidity(ta)) / kWaterDensity);
        state_.evaporation_m_s[k] = static_cast<float>(potential);
        const double wetness = water.empty() ? 0.0 : std::min(1.0, double(water[k]) / kQ24 / kWetFilmM);
        const double latent = kLatentHeat * kWaterDensity * potential * wetness;
        const int substeps = std::max(1, int(std::ceil(dt / 600.0)));
        const double h = dt / substeps;
        for (int n = 0; n < substeps; ++n) {
            const double ts_k = ts + kKelvin, ts_k2 = ts_k * ts_k;
            const double net = (1 - p.albedo) * shortwave + p.emissivity * sky_lw - p.emissivity * kStefanBoltzmann * ts_k2 * ts_k2 -
                               h_conv * (ts - ta) - p.ground_conductance_w_m2k * (ts - deep_c) + p.anthropogenic_w_m2 - latent;
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
    const auto interval = std::uint32_t(hydrology_.interval_s);
    if (t % interval == 0) {
        if (in.hydrology) update_hydrology(t, in.storms, in.drainage);
        else state_.water.updated_s = t;
    }
    state_.time_s = t;
}

double EnvironmentRuntime::rain_rate_mm_h(double x, double y, const std::vector<StormCell>& storms) const {
    // Storms combine as independent probabilities, as the road network's
    // rain does: 1 - prod(1 - I_k W_k), scaled to the peak rate.
    double dry = 1;
    for (const auto& s : storms) dry *= 1 - std::clamp(s.intensity, 0.0, 1.0) * wendland(std::hypot(x - s.x_m, y - s.y_m), s.radius_m);
    return hydrology_.rain_peak_mm_h * (1 - dry);
}

void EnvironmentRuntime::update_hydrology(std::uint32_t t, const std::vector<StormCell>& storms, bool drainage) {
    auto& w = state_.water;
    const auto& g = hydrology_grid_.grid;
    const auto cells = g.cells();
    const double interval = hydrology_.interval_s;
    HydrologySources src;
    bool raining = false;
    double peak = 0;
    if (!storms.empty()) {
        src.rain.assign(cells, 0);
        for (std::uint32_t j = 0; j < g.height; ++j)
            for (std::uint32_t i = 0; i < g.width; ++i) {
                const auto k = g.index(i, j);
                const double rate = rain_rate_mm_h(g.centre_x(i), g.centre_y(j), storms);
                peak = std::max(peak, rate);
                // Depth this step in Q24, the fraction below one quantum carried
                // to the next step so the total over a storm is exact.
                const double depth = rate / 3.6e6 * interval * kQ24 + w.rain_carry[k];
                const double whole = std::floor(depth);
                w.rain_carry[k] = depth - whole;
                src.rain[k] = static_cast<std::int32_t>(whole);
                raining = raining || whole > 0;
            }
    }
    w.peak_rain_mm_h = std::max(w.peak_rain_mm_h, peak);
    // A dry district with no rain is unchanged by a step: skip it. (This is
    // exact, not an approximation: with no water every flux and sink is zero.)
    if (!raining && w.stored == 0 && state_.drains.stored == 0) {
        w.updated_s = t;
        return;
    }
    src.evaporation.assign(cells, 0);
    src.infiltration.assign(cells, 0);
    // Every cell gets its potential: the solver takes no more than is there,
    // so this does not depend on whether the host's copy of h is current.
    for (std::size_t k = 0; k < cells; ++k) {
        const double evap = double(state_.evaporation_m_s[k]) * interval * kQ24 + w.evap_carry[k];
        const double whole = std::floor(evap);
        w.evap_carry[k] = evap - whole;
        src.evaporation[k] = static_cast<std::int32_t>(whole);
        src.infiltration[k] = static_cast<std::int32_t>(std::floor(double(hydrology_grid_.infiltration_m_s[k]) * interval * kQ24));
    }
    // The drains take their share of the street water first, from depths the
    // host holds exactly (a device-resident solver's are fetched).
    std::vector<std::int64_t> exchange;
    if (drainage && !drainage_.nodes.empty()) {
        sync_water();
        src.drain.assign(cells, 0);
        exchange = inlet_exchange(drainage_, drainage_params_, state_.drains, w.h, interval, src.drain);
    }
    const auto sub = hydrology_substeps(interval, g.cell_m, w.h_max, hydrology_);
    try {
        hydrology_solver_->advance(w, src, sub.dt_s, sub.substeps, hydrology_);
    } catch (const compute::ComputeError& e) {
        // The device failed mid-step and the step's state went with it. Carry
        // on with the CPU, and let the engine restore its latest checkpoint
        // and replay to here, exactly as it does for the traffic step.
        hydrology_solver_ = make_cpu_hydrology_solver();
        hydrology_solver_->install(hydrology_grid_);
        water_stale_ = false;
        throw compute::StateLost(std::string("surface water: ") + e.what());
    }
    if (!hydrology_solver_->host_resident()) water_stale_ = true;
    ++road_revision_;
    if (!exchange.empty()) drainage_step(drainage_, drainage_params_, state_.drains, exchange, interval);
    // Froude diagnostics need the fields; they are taken on whole minutes, on
    // every backend, so a device-resident solver reads its fields once a
    // minute while there is water, and results do not depend on the backend.
    if (t % 60 == 0) {
        if (w.stored > 0) {
            sync_water();
            detect_hotspots(hydrology_grid_, w);
        } else {
            w.max_froude = 0;
            w.supercritical_cells = 0;
            w.hotspots.clear();
        }
    }
    w.substeps = sub.substeps;
    w.dt_s = sub.dt_s;
    w.cfl_capped = sub.capped;
    w.updated_s = t;
    const double area = g.cell_m * g.cell_m;
    w.peak_depth_m = std::max(w.peak_depth_m, double(w.h_max) / kQ24);
    w.peak_flooded_area_m2 = std::max(w.peak_flooded_area_m2, w.flooded_cells * area);
    depth_stale_ = true;
}

RoadEnvironment EnvironmentRuntime::road(std::size_t e, bool full) const {
    RoadEnvironment r;
    if (e >= grade_factor_.size()) return r;
    const auto& w = state_.water;
    r.grade = edge_grade_[e];
    r.grade_factor = grade_factor_[e];
    if (e < w.road_max.size()) {
        r.water_max_m = double(w.road_max[e]) / kQ24;
        r.water_mean_m = double(w.road_mean[e]) / kQ24;
    }
    // The flood index: puddles below 2 cm do not count; a car's wading depth is 1.
    constexpr double kPuddleM = 0.02;
    static const double wading = vehicle_params(VehicleClass::SmallPassenger).wading_depth_m;
    r.flood_index = std::clamp((r.water_max_m - kPuddleM) / (wading - kPuddleM), 0.0, 1.0);
    r.water_factor = water_speed_factor(r.water_max_m);
    for (std::size_t c = 0; c < kVehicleClasses.size(); ++c) r.passable[c] = r.water_max_m < vehicle_params(kVehicleClasses[c]).wading_depth_m;
    r.closed = !r.passable[std::size_t(VehicleClass::SmallPassenger)];
    r.speed_multiplier = r.grade_factor * r.water_factor;
    // Capacity falls with the speed the water allows; grade's effect on
    // capacity (heavier vehicles' longer headways uphill) is not modelled.
    r.capacity_multiplier = r.water_factor;
    if (full) {
        const auto [x, y] = edge_mid_[e];
        r.surface_temperature_c = state_.surface_temperature_c.empty() ? 0.0
                                  : sample_bilinear(terrain_->grid, state_.surface_temperature_c.data(), x, y);
        r.energy_kwh_per_km = energy_kwh_per_km(vehicle_params(VehicleClass::SmallPassenger), free_speed_[e] * r.speed_multiplier, r.grade, 0);
    }
    return r;
}

void EnvironmentRuntime::refresh_water_field() const {
    sync_water();
    if (!depth_stale_) return;
    depth_stale_ = false;
    const auto& h = state_.water.h;
    water_depth_m_.resize(h.size());
    for (std::size_t k = 0; k < h.size(); ++k) water_depth_m_[k] = static_cast<float>(double(h[k]) / kQ24);
}

std::vector<std::pair<std::string, std::string>> EnvironmentRuntime::fields() const {
    if (!terrain_) return {};
    return {{"elevation", "m"}, {"slope", "m/m"}, {"irradiance", "W/m²"}, {"surface_temperature", "°C"}, {"cloud", "fraction"},
            {"water_depth", "m"}};
}

const std::vector<float>* EnvironmentRuntime::field(const std::string& name) const {
    if (!terrain_) return nullptr;
    if (name == "elevation") return &terrain_->elevation_m;
    if (name == "slope") return &terrain_->slope;
    if (name == "irradiance") return &state_.irradiance_w_m2;
    if (name == "surface_temperature") return &state_.surface_temperature_c;
    if (name == "cloud") return &state_.cloud_fraction;
    if (name == "water_depth") {
        refresh_water_field();
        return &water_depth_m_;
    }
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
    const auto& w = state_.water;
    const auto& hg = hydrology_grid_.grid;
    const double cell_area = hg.cell_m * hg.cell_m;
    const auto m3 = [&](std::int64_t q24) { return double(q24) / kQ24 * cell_area; };
    const auto expected = w.ledger.expected();
    const double error = m3(expected - w.stored);
    std::size_t pervious = 0, sea = 0;
    for (const auto v : hydrology_grid_.pervious) pervious += v;
    for (const auto f : hydrology_grid_.flags) sea += (f & 1u) != 0;
    nlohmann::json hydrology{
        {"updated_s", w.updated_s},
        {"interval_s", hydrology_.interval_s},
        {"scheme", "local-inertial shallow water (Bates et al. 2010), integer fixed point"},
        {"solver", hydrology_solver_ ? hydrology_solver_->name() : "none"},
        {"substeps", w.substeps}, {"dt_s", w.dt_s}, {"cfl_capped", w.cfl_capped},
        {"stored_m3", m3(w.stored)},
        {"max_depth_m", double(w.h_max) / kQ24},
        {"wet_cells", w.wet_cells}, {"flooded_cells", w.flooded_cells},
        {"flooded_area_m2", w.flooded_cells * cell_area},
        {"peak_rain_mm_h", w.peak_rain_mm_h}, {"peak_depth_m", w.peak_depth_m}, {"peak_flooded_area_m2", w.peak_flooded_area_m2},
        {"ledger_m3", {{"initial", m3(w.ledger.initial)}, {"rain", m3(w.ledger.rain)}, {"boundary_outflow", m3(w.ledger.boundary)},
                       {"open_water", m3(w.ledger.sea)}, {"evaporated", m3(w.ledger.evaporated)}, {"infiltrated", m3(w.ledger.infiltrated)},
                       {"drained", m3(w.ledger.drained)}}},
        {"conservation_error_m3", error},
        {"conservation_error_relative", std::abs(error) / std::max(1e-9, m3(w.ledger.initial + w.ledger.rain))},
        {"pervious_cells", pervious}, {"open_water_cells", sea},
        {"max_froude", w.max_froude}, {"supercritical_cells", w.supercritical_cells},
        {"refinement_candidates", [&] {
            auto list = nlohmann::json::array();
            for (const auto k : w.hotspots)
                list.push_back({{"x_m", hg.centre_x(std::uint32_t(k % hg.width))}, {"y_m", hg.centre_y(std::uint32_t(k / hg.width))},
                                {"depth_m", double(w.h[k]) / kQ24}});
            return list;
        }()},
        {"refinement", "detected only: no 3D solver is coupled; see the documentation"},
        {"parameters", {{"manning_n", hydrology_.manning_n}, {"cfl", hydrology_.cfl}, {"min_flow_depth_m", hydrology_.min_flow_depth_m},
                        {"rain_peak_mm_h", hydrology_.rain_peak_mm_h}, {"pervious_infiltration_mm_h", hydrology_.pervious_infiltration_mm_h}}}
    };
    return {
        {"time_s", state_.time_s},
        {"hydrology", std::move(hydrology)},
        {"drainage", drainage_summary(drainage_, state_.drains, drainage_params_)},
        {"water_system", {
            // Street and pipes together: rain in, and everything that has left.
            {"rain_m3", m3(w.ledger.rain)},
            {"on_streets_m3", m3(w.stored)},
            {"in_drains_m3", double(state_.drains.stored) * cell_area / kQ24},
            {"left_m3", m3(w.ledger.boundary + w.ledger.sea + w.ledger.evaporated + w.ledger.infiltrated) +
                            double(state_.drains.outfall) * cell_area / kQ24},
            {"conservation_error_m3", m3(w.ledger.initial + w.ledger.rain - w.ledger.boundary - w.ledger.sea - w.ledger.evaporated -
                                          w.ledger.infiltrated - w.stored - state_.drains.stored - state_.drains.outfall)}}},
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
            {"sun_path", [&] {
                auto path = nlohmann::json::array();
                for (const auto& [t, el, az] : sun_path_) path.push_back({{"t", t}, {"elevation_deg", el}, {"azimuth_deg", az}});
                return path;
            }()},
            {"surface", {{"class", "asphalt (assumed everywhere)"}, {"albedo", surface_.albedo}, {"emissivity", surface_.emissivity},
                         {"heat_capacity_j_m2k", surface_.heat_capacity_j_m2k}}}
        }}
    };
}

} // namespace dstns::env
