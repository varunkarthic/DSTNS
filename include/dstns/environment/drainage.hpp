// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// DDS: the deterministic drainage system. Water reaching a drain is not
// deleted: it enters a pipe network with finite capacity, travels downstream,
// and leaves at an outfall, or backs up and returns to the street.
//
// No city here publishes its sewers, so the network is a SYNTHETIC
// deterministic approximation, and says so in every report:
//
//   layout     pipes under streets, along a shortest-path forest from the
//              outfalls (the lowest junctions on the district's edge, and
//              junctions beside open water), so every junction drains to one
//   inverts    at least `min_cover_m` below ground, falling towards the outfall
//              at `min_slope` where the ground allows
//   diameters  the smallest standard size whose full-flow capacity carries the
//              design storm from everything upstream (rational method,
//              Q = C i A); a heavier storm overloads it
//   inlets     grates along every street, `inlet_spacing_m` apart on each kerb,
//              draining to the nearer junction; each captures street water by
//              the weir or orifice relation, whichever is smaller, and returns
//              it when the network is surcharged above the street
//
// Hydraulics: a node-link model. Each node stores water (its manhole shaft and
// half of every pipe it joins); each pipe carries Manning flow driven by the
// difference in hydraulic head, limited so it never overshoots the heads it
// equalises or takes more than a node holds. A full Saint-Venant solver could
// replace step() behind the same interface.
//
// Volumes are integers in the surface model's own unit (Q24 metres of depth
// on one grid cell), so water moves between street and pipe exactly:
//
//     drained in from the surface = stored in the network + discharged at outfalls

#include "dstns/environment/grid.hpp"

#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace dstns {
struct Scenario;
}

namespace dstns::env {

struct Terrain;
struct HydrologyGrid;

struct DrainageParams {
    double design_rain_mm_h{25};      // the storm the pipes are sized for (about a 2-year return in many cities)
    double runoff_coefficient{0.85};  // C in Q = C i A, for sealed urban catchments
    double min_cover_m{1.2};          // ground to pipe invert
    double min_slope{0.003};
    double manning_n{0.013};          // concrete pipe
    double manhole_area_m2{1.1};      // a 1.2 m shaft
    double grate_area_m2{0.24};       // a 600 x 400 mm grate
    double grate_perimeter_m{2.0};
    double inlet_spacing_m{50};       // between grates along each kerb
    double weir_coefficient{1.66};    // m^0.5/s, SI
    double orifice_coefficient{0.67};
    double substep_s{1};
    std::uint32_t max_outfalls{8};
};

struct DrainNode {
    std::uint32_t road_node{};        // the junction it sits under
    std::uint32_t cell{};             // the grid cell its inlet drains
    double ground_m{}, invert_m{};
    bool outfall{};
    double shaft_area_m2{};           // the manhole's plan area
    double pipe_volume_m3{};          // half of every pipe it joins, full
    double crown_m{};                 // invert + its largest pipe's diameter
};

/// The grates in one grid cell that drain to one junction.
struct DrainInlet {
    std::uint32_t cell{}, node{};
    double grates{};
};

struct DrainPipe {
    std::uint32_t from{}, to{};       // drain nodes; flow is positive from -> to (downstream)
    double length_m{}, diameter_m{}, slope{};
    double full_capacity_m3_s{};      // Manning, full, at the invert slope
    double conveyance_m3_s{};         // A R^(2/3) / n, full: Q = K sqrt(S)
};

struct DrainageNetwork {
    std::vector<DrainNode> nodes;
    std::vector<DrainPipe> pipes;
    std::vector<DrainInlet> inlets;   // ordered by cell, then node
    double cell_area_m2{};            // one volume unit is cell_area / 2^24 m^3
    std::string source{"synthetic"};  // never imported: no real network data
};

/// The network's state: part of the environment's checkpointed state.
struct DrainageState {
    std::vector<std::int64_t> volume;   // per node, in volume units
    std::vector<double> flow_m3_s;      // per pipe, last substep
    std::int64_t inflow{}, outfall{}, backflow{};  // since the start, volume units
    std::int64_t stored{};
    std::uint32_t surcharged_nodes{}, full_pipes{};
    double peak_utilisation{};          // largest flow / full capacity seen
    std::uint32_t peak_surcharged{};
    std::vector<std::uint8_t> surcharged; // per node, for transition events
};

[[nodiscard]] DrainageNetwork build_drainage(const Scenario& scenario, const Terrain& terrain, const HydrologyGrid& grid,
                                             const DrainageParams& params);
[[nodiscard]] DrainageState initial_drainage(const DrainageNetwork& network);

/// Inlet exchange with the street for one surface step: for each node, the
/// volume it captures (positive) or returns (negative), given the street's
/// depth h (Q24 per cell). Captures never exceed the street water; returns
/// never exceed the node's water above the street. Returns the amount per
/// node and adds it to `drain` (per cell), which the surface step honours
/// exactly (drains are applied before any other sink).
[[nodiscard]] std::vector<std::int64_t> inlet_exchange(const DrainageNetwork& network, const DrainageParams& params,
                                                       const DrainageState& state, const std::vector<std::int32_t>& h, double dt_s,
                                                       std::vector<std::int32_t>& drain);

/// Credit each node with exactly its exchange, then route the water through
/// the pipes for `dt_s`.
void drainage_step(const DrainageNetwork& network, const DrainageParams& params, DrainageState& state,
                   const std::vector<std::int64_t>& exchange, double dt_s);

/// Hydraulic head (m) at a node holding `volume` units.
[[nodiscard]] double node_head(const DrainNode& node, const DrainageNetwork& network, std::int64_t volume);

[[nodiscard]] nlohmann::json drainage_summary(const DrainageNetwork& network, const DrainageState& state, const DrainageParams& params);

} // namespace dstns::env
