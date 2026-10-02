// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// DAS: the deterministic atmosphere system. The near-surface wind over the
// district, shaped by its buildings, its terrain and the Sun's heating of its
// streets.
//
//   canopy      building footprints from OpenStreetMap, rasterised as a plan
//               area fraction and a mean height per grid cell; heights from
//               `height`, else `building:levels`, else estimated by kind
//   background  the wind above the city: a prevailing direction and speed
//               for the latitude's wind belt, the day's departure from it
//               drawn from the run's own stream, a diurnal cycle, and gusts
//               under storm cells
//   flow        a three-dimensional lattice Boltzmann model (D3Q19, BGK with
//               a Smagorinsky eddy viscosity) over the district, driven at
//               its edges by a logarithmic boundary-layer profile; buildings
//               act as a distributed (porous canopy) drag, the ground as a
//               log-law wall drag, terrain as solid cells, and the street's
//               heating as a Boussinesq buoyancy force
//
// The flow is solved to a steady state on a fixed cadence (hourly) from the
// inflow profile, so each solve depends only on its inputs at that instant
// and replay from any checkpoint meets the same solves. Between solves the
// field follows the background speed and storm gusts by scaling.
//
// The lattice update is local to each cell, so its result does not depend on
// how many threads compute it.

#include "dstns/environment/grid.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace dstns {
struct Scenario;
}

namespace dstns::env {

struct Terrain;

struct AtmosphereParams {
    std::uint32_t max_side_cells{64};   // horizontal lattice cells, at most, along the longer side
    std::uint32_t min_layers{8};
    std::uint32_t max_layers{16};
    double top_m{250};                  // the domain reaches at least this far above the ground
    double lattice_top_speed{0.1};      // inflow speed at the top, lattice units (Mach 0.17)
    double flow_throughs{0.8};          // iterations: the inflow crosses the lattice this many times at the top
    double tau0{0.52};                  // molecular relaxation time; the rest is eddy viscosity
    double smagorinsky{0.16};
    double canopy_drag{1.2};            // C_d of the building canopy (Coceal and Belcher 2004)
    double building_width_m{15};        // a typical building's width, for frontal area density
    double open_z0_m{0.03};             // roughness of open ground (short grass)
    double buoyancy_height_m{100};      // e-folding height of the street's heating
    double max_buoyancy_lattice{3e-4};  // stability bound on the buoyant acceleration
    double min_scaling_speed_mps{2.0};  // calmer winds are solved as this, for the lattice's sake
    double sponge_cells{4};             // relaxation band at the open boundaries
    double storm_gust{0.6};             // fractional speed-up under a storm cell's core
    double reference_height_m{10};      // the height the wind is reported at
    std::uint32_t solve_interval_s{3600};
    // At each solve instant, solve again only if the inputs have moved this
    // far since the last solve; otherwise the last solution stands.
    double resolve_turn_deg{5};
    double resolve_heating_k{1};
    std::uint32_t threads{0};           // 0: up to 8, from the hardware
    // Estimated heights when a footprint has no `height` or `building:levels`.
    double storey_m{3.0};
    double default_height_m{12};        // four storeys
    double house_height_m{7};
    double small_height_m{3.5};         // garages, sheds, kiosks
};

/// The district's buildings on the environment grid.
struct UrbanCanopy {
    std::vector<float> plan_fraction;   // lambda_p: built plan area / cell area
    std::vector<float> height_m;        // footprint-weighted mean height
    std::uint32_t buildings{}, height_tagged{}, levels_tagged{}, estimated{};
    double built_fraction{}, mean_height_m{}, max_height_m{};
    double mean_footprint_m2{};
};

[[nodiscard]] UrbanCanopy build_canopy(const Scenario& scenario, const GridSpec& grid, const AtmosphereParams& params);
/// A building's height from its tags: `height` (m, or feet with ' or ft),
/// else `building:levels` storeys, else an estimate for its kind. `source`
/// is set to height, levels or estimated.
[[nodiscard]] double building_height(const std::map<std::string, std::string>& tags, const AtmosphereParams& params,
                                     std::string* source = nullptr);

/// The wind above the city at the reference height over open ground.
struct BackgroundWind {
    double speed_mps{};
    double from_deg{};                  // meteorological: where it blows from, clockwise from north
};

/// A run's wind climate: fixed for the run, from latitude, month and seed.
struct WindClimate {
    double mean_speed_mps{};            // the day's mean at 10 m
    double prevailing_from_deg{};
    double veer_deg{};                  // amplitude of the diurnal swing in direction
    double phase_h{};                   // solar hour of the direction swing's maximum
    std::string belt;                   // trades, westerlies, polar easterlies, doldrums
};
[[nodiscard]] WindClimate wind_climate(const Scenario& scenario, double latitude);
/// The background wind at a solar time: stronger in the afternoon, when the
/// boundary layer mixes momentum down, and swinging slowly in direction.
[[nodiscard]] BackgroundWind background_wind(const WindClimate& climate, double solar_time_h);

/// The lattice laid over the environment grid: `factor` grid cells per
/// lattice cell each way; cubic cells of side dx.
struct AtmosphereLattice {
    std::uint32_t nx{}, ny{}, nz{}, factor{1};
    double dx_m{};
    GridSpec columns;                   // the lattice's columns, as a grid
    std::vector<std::uint8_t> solid;    // per lattice cell: terrain
    std::vector<std::uint16_t> ground;  // per column: the first fluid layer
    std::vector<float> canopy_k;        // per lattice cell: drag per unit speed, lattice units
    std::vector<float> ground_k;        // per column: wall drag in the first fluid layer
    std::vector<float> z0_m;            // per column: roughness length
    std::vector<float> displacement_m;  // per column: zero-plane displacement
    [[nodiscard]] std::size_t cells() const { return std::size_t(nx) * ny * nz; }
    [[nodiscard]] std::size_t index(std::uint32_t i, std::uint32_t j, std::uint32_t k) const {
        return (std::size_t(k) * ny + j) * nx + i;
    }
};
[[nodiscard]] AtmosphereLattice build_lattice(const Terrain& terrain, const UrbanCanopy& canopy, const AtmosphereParams& params);

/// A steady wind field, per lattice column at the reference height above the
/// canopy, as a multiple of the background speed it was solved for.
struct WindSolution {
    std::vector<float> u, v;            // east and north, per column, per m/s of background
    std::vector<float> w;               // vertical at the first fluid layer, per m/s of background
    BackgroundWind solved_for;
    std::uint32_t iterations{};
    double max_mach{}, mean_density_error{};
    bool converged{};                   // the field stopped changing (largest change < 1e-4 per iteration)
    double last_change{};
};
/// Solve for the steady flow. `heating_k` is per lattice column: the
/// street's surface temperature above the air, K (empty: neutral).
[[nodiscard]] WindSolution solve_wind(const AtmosphereLattice& lattice, const BackgroundWind& wind, const std::vector<float>& heating_k,
                                      double air_temperature_c, const AtmosphereParams& params);

/// The log-law profile shape: speed at z over speed at the reference height.
[[nodiscard]] double log_profile(double z_m, double z0_m, double reference_m);

} // namespace dstns::env
