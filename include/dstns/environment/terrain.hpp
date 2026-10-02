// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// DEM: the terrain under the district.
//
// Elevation z(x, y) in metres, on the environment grid, with its gradient and
// slope precomputed. It comes from a DemProvider, so the simulation is not tied
// to one remote service:
//
//   terrarium   AWS Open Data Terrain Tiles (Mapzen/Tilezen), cached per tile
//   flat        z = 0 everywhere (configured, or the fallback when a DEM
//               cannot be had, in which case the run is marked degraded)
//   synthetic   an analytic surface for tests and validation scenarios,
//               never presented as observed terrain
//
// Pipeline: district bounds -> grid -> tile set -> cache lookup -> download of
// what is missing -> validation -> resampling to the grid -> gradient and
// slope. A provider that cannot deliver never stops the run unless the
// configuration requires terrain.

#include "dstns/environment/grid.hpp"
#include "dstns/model.hpp"

#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace dstns::env {

/// Where an elevation field came from: enough to reproduce or cite it.
struct DemProvenance {
    std::string source{"flat"};   // terrarium | flat | synthetic
    std::string provider, dataset, licence, attribution, note;
    std::string cache_id, fetched_at;
    std::uint32_t zoom{};
    double native_resolution_m{};
    double south{}, west{}, north{}, east{};
    bool observed{};              // imported measurements, not invented
    bool degraded{};              // a fallback stands in for what was asked
};

class DemUnavailable : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct GeoBox {
    double south{}, west{}, north{}, east{};
};

/// A provider's answer: elevation at any point of the box, NaN where it has
/// no data.
struct DemSampler {
    std::function<double(double lat, double lon, double x_m, double y_m)> elevation;
    DemProvenance provenance;
};

class DemProvider {
public:
    virtual ~DemProvider() = default;
    [[nodiscard]] virtual std::string name() const = 0;
    /// Throws DemUnavailable when the box cannot be covered.
    [[nodiscard]] virtual DemSampler open(const GeoBox& box, double cell_m) = 0;
};

/// Terrain tiles in Terrarium encoding, fetched by scripts/fetch_dem.py into
/// `cache_dir`/terrarium/z/x/y.png and decoded here.
[[nodiscard]] std::unique_ptr<DemProvider> make_terrarium_provider(const std::string& cache_dir);
/// z = 0. `note` explains why, for the provenance.
[[nodiscard]] std::unique_ptr<DemProvider> make_flat_provider(std::string note, bool degraded);
/// An analytic surface in local metres about the grid centre:
///   synthetic:slope[:g]   plane rising eastwards at grade g (default 0.05)
///   synthetic:bowl[:d]    paraboloid depression d metres deep at the centre (default 10)
///   synthetic:hill[:h]    Gaussian hill h metres high (default 30)
///   synthetic:valley[:d]  V-shaped valley along x = centre, sides rising d metres (default 15)
/// Throws std::invalid_argument for an unknown shape.
[[nodiscard]] std::unique_ptr<DemProvider> make_synthetic_provider(const std::string& spec, double centre_x_m, double centre_y_m,
                                                                   double half_extent_m);

/// The decoded Terrarium elevation, metres, of one pixel.
[[nodiscard]] constexpr double terrarium_elevation(std::uint8_t r, std::uint8_t g, std::uint8_t b) {
    return r * 256.0 + g + b / 256.0 - 32768.0;
}
/// Web Mercator tile containing a point, and the global pixel position (256 px tiles).
[[nodiscard]] std::pair<double, double> mercator_pixel(double lat, double lon, std::uint32_t zoom);
/// The zoom whose pixels are no larger than `metres` at `latitude`, within [10, 14].
[[nodiscard]] std::uint32_t terrarium_zoom_for(double metres, double latitude);

struct Terrain {
    GridSpec grid;
    LocalProjection projection;
    std::vector<float> elevation_m;   // z, per cell
    std::vector<float> dzdx, dzdy;    // dimensionless gradient
    std::vector<float> slope;         // |grad z|, rise over run
    float min_m{}, max_m{};
    double sea_mask_m{-10};           // cells below are open water to the hydrology
    double grade_baseline_m{100};     // shortest run a road grade is measured over
    DemProvenance provenance;
    std::string hash;                 // sha256 of the quantised field and its source

    [[nodiscard]] bool empty() const { return elevation_m.empty(); }
    [[nodiscard]] double elevation_at(double x_m, double y_m) const;
    [[nodiscard]] std::pair<double, double> gradient_at(double x_m, double y_m) const;
};

/// Lay the grid over the scenario's nodes and features and fill it from the
/// provider the configuration names. Falls back to flat terrain, marked
/// degraded, unless the configuration requires a DEM.
[[nodiscard]] Terrain build_terrain(const Scenario& scenario, const EnvironmentConfig& config);
/// The same with an explicit provider (tests, tools).
[[nodiscard]] Terrain build_terrain(const Scenario& scenario, const EnvironmentConfig& config, DemProvider& provider);

/// The grid the environment uses for this scenario: the bounding box of its
/// roads and places plus a margin, at the configured cell size, coarsened if
/// it would exceed the cell budget.
[[nodiscard]] GridSpec environment_grid(const Scenario& scenario, const EnvironmentConfig& config);
/// The projection that produced the scenario's metres.
[[nodiscard]] LocalProjection scenario_projection(const Scenario& scenario);

/// Fill NaN cells from their valid neighbours, deterministically (row-major
/// passes, averaging the four neighbours known so far). Returns the share of
/// cells that were missing.
double fill_missing(const GridSpec& grid, std::vector<float>& field);
/// One pass of the 3x3 binomial filter (weights 1-2-1 by 1-2-1), edges replicated.
void smooth_binomial(const GridSpec& grid, std::vector<float>& field);
/// Central differences inside, one-sided at the edges.
void compute_gradient(Terrain& terrain);

/// Directional grade of every edge and elevation of every node, from the
/// terrain: grade(A->B) = (z_B - z_A) / d_AB, so a twin's grade is the
/// negation of its own.
void apply_terrain(Scenario& scenario, const Terrain& terrain);

} // namespace dstns::env
