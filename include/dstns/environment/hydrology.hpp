// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// DWS surface water: rain on the terrain, flowing downhill, ponding in
// depressions, leaving through the edge of the district or into the sea, and
// removed only by physical sinks (evaporation, infiltration and, with the
// drainage model, the drains). Water never disappears on a timer.
//
// The solver is the local-inertial shallow-water scheme of
// shaders/include/dstns_hydrology.h, run on the environment grid in fixed
// point. Every change in stored water is booked to the ledger, so
//
//     stored(t) = stored(0) + rain - boundary - sea - evaporated - infiltrated - drained
//
// holds exactly, in integers; the reported conservation error is that
// identity's residual, which a correct build keeps at zero.

#include "dstns/compute/backend.hpp"
#include "dstns/compute/options.hpp"
#include "dstns/environment/grid.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace dstns {
struct Scenario;
}

namespace dstns::env {

struct Terrain;

struct HydrologyParams {
    double manning_n{0.016};             // s/m^(1/3): smooth asphalt and concrete
    double cfl{0.7};                     // Courant number for the inertial scheme
    double theta{0.8};                   // q-centred weighting (de Almeida et al. 2012); 1 = unweighted
    double min_flow_depth_m{1e-4};       // thinner films do not flow (wet/dry)
    double interval_s{5};                // one hydrology step; divides the 900 s checkpoint
    std::uint32_t max_substeps{64};      // a safety bound on CFL subdivision
    double rain_peak_mm_h{50};           // a storm of intensity 1 at its centre
    double pervious_infiltration_mm_h{10}; // parks, grass, woodland: steady capacity
    double impervious_infiltration_mm_h{0};
    double evaporation_coefficient{1.5e-3}; // bulk transfer coefficient C_E
    double relative_humidity{0.70};      // background; under storm cloud it rises to 0.98
};

/// What does not change during a run.
struct HydrologyGrid {
    GridSpec grid;
    std::vector<std::int32_t> z_q16;     // terrain, Q16 m
    std::vector<std::uint32_t> flags;    // HYD_SEA
    std::vector<float> infiltration_m_s; // capacity per cell
    std::vector<std::uint8_t> pervious;
    // Cells each directed road edge crosses (CSR): offsets has edges + 1 entries.
    std::vector<std::uint32_t> road_offsets, road_cells;

    [[nodiscard]] std::size_t cells() const { return grid.cells(); }
    [[nodiscard]] std::size_t faces_x() const { return std::size_t(grid.width + 1) * grid.height; }
    [[nodiscard]] std::size_t faces_y() const { return std::size_t(grid.width) * (grid.height + 1); }
};

/// The exact water budget, in Q24 metres summed over cells (multiply by
/// cell area / 2^24 for cubic metres).
struct WaterLedger {
    std::int64_t initial{}, rain{}, boundary{}, sea{}, evaporated{}, infiltrated{}, drained{};
    [[nodiscard]] std::int64_t expected() const { return initial + rain - boundary - sea - evaporated - infiltrated - drained; }
};

/// Everything that changes: part of the environment's checkpointed state.
struct HydrologyState {
    std::vector<std::int32_t> h;         // Q24 m per cell
    std::vector<std::int32_t> qx, qy;    // Q20 m^2/s per face
    std::vector<double> rain_carry, evap_carry; // sub-quantum remainders, so totals are exact over time
    WaterLedger ledger;
    std::int64_t stored{};               // sum of h
    std::int64_t h_max{};
    std::uint32_t wet_cells{}, flooded_cells{};
    std::uint32_t substeps{};
    double dt_s{};
    bool cfl_capped{};
    std::uint32_t updated_s{};
    // Where the shallow-water picture is weakest: wet cells whose Froude
    // number exceeds 0.5 (the inertial scheme's stated range) and whose depth
    // changes sharply to a neighbour. Candidates for local refinement.
    double max_froude{};
    std::uint32_t supercritical_cells{};
    std::vector<std::uint32_t> hotspots;  // up to 8 cells, strongest first
    // Peaks over the run so far, for reports.
    double peak_rain_mm_h{}, peak_depth_m{}, peak_flooded_area_m2{};
    // Per directed edge, from the last step: deepest and mean water over the cells it crosses.
    std::vector<std::int32_t> road_max, road_mean;
};

/// Per-step sources prepared by the host, in Q24 per cell.
struct HydrologySources {
    std::vector<std::int32_t> rain;      // added
    std::vector<std::int32_t> evaporation, infiltration; // potential removal, limited by what is there
};

/// Build the static grid: terrain in fixed point, sea cells, pervious cells
/// from mapped parks and green space, and the cells under every road.
[[nodiscard]] HydrologyGrid build_hydrology_grid(const Scenario& scenario, const Terrain& terrain, const HydrologyParams& params);
/// Dry state for a grid.
[[nodiscard]] HydrologyState initial_hydrology(const HydrologyGrid& grid);

/// The solver: CPU reference here; a Vulkan backend computes the same bits.
class HydrologySolver {
public:
    virtual ~HydrologySolver() = default;
    virtual void install(const HydrologyGrid& grid) = 0;
    /// Make the solver's state equal to `state`.
    virtual void upload(const HydrologyState& state) = 0;
    /// Apply the sources, then advance `substeps` steps of `dt_s`. On return
    /// the ledger, statistics and road summaries in `state` are current; the
    /// fields h, qx, qy are current on the host only if `host_resident()`.
    virtual void advance(HydrologyState& state, const HydrologySources& sources, double dt_s, std::uint32_t substeps,
                         const HydrologyParams& params) = 0;
    /// Bring h, qx and qy to the host.
    virtual void download(HydrologyState& state) = 0;
    [[nodiscard]] virtual bool host_resident() const = 0;
    [[nodiscard]] virtual std::string name() const = 0;
};

[[nodiscard]] std::unique_ptr<HydrologySolver> make_cpu_hydrology_solver();
/// The same solver on a Vulkan device: the state stays on the device and the
/// host reads only per-row tallies and per-road summaries after each step.
/// nullptr, with `reason` set, when no usable device exists.
[[nodiscard]] std::unique_ptr<HydrologySolver> make_vulkan_hydrology_solver(const compute::ComputeOptions& options,
                                                                            const compute::LogSink& log, std::string& reason);

/// One substep's constants, rounded once on the host, identical for every solver:
/// a = g dt / dx (Q20), k = g dt n^2 (Q32), c = dt / dx (Q24), the wet/dry
/// depth (Q24) and the q-centred weight theta (Q16).
struct HydrologyCoefficients {
    std::int64_t a_q20{}, k_q32{}, c_q24{}, hmin{}, theta{};
};
[[nodiscard]] HydrologyCoefficients hydrology_coefficients(double dt, double dx, const HydrologyParams& params);

/// Froude diagnostics and refinement candidates from the current h, qx, qy.
void detect_hotspots(const HydrologyGrid& grid, HydrologyState& state);

/// The step length and count that keep the scheme stable for the deepest
/// water: dt <= cfl dx / sqrt(g h_max), dividing `interval_s` evenly.
struct SubStepping {
    double dt_s{};
    std::uint32_t substeps{};
    bool capped{};
};
[[nodiscard]] SubStepping hydrology_substeps(double interval_s, double cell_m, std::int64_t h_max_q24, const HydrologyParams& params);

constexpr double kQ24 = 16777216.0;
constexpr double kQ20 = 1048576.0;

} // namespace dstns::env
