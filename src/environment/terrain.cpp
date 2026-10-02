// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/terrain.hpp"

#include "dstns/environment/png.hpp"
#include "dstns/osm_fetch.hpp"
#include "dstns/rng.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <nlohmann/json.hpp>
#include <sstream>

namespace dstns::env {
namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kEquatorMetresPerPixelZ0 = 156543.03392804097;  // 2 pi R / 256
constexpr std::uint32_t kTile = 256;
// Below the deepest ocean trench or above Everest: not an elevation.
constexpr double kLowestPlausibleM = -12000, kHighestPlausibleM = 9000;
constexpr double kMaxRoadGrade = 0.35;
constexpr const char* kTerrariumAttribution =
    "Terrain: Mapzen terrain tiles (AWS Open Data); SRTM and GMTED2010 courtesy of the U.S. Geological Survey, "
    "ETOPO1 courtesy of NOAA NCEI, 3DEP courtesy of the USGS, and regional sources listed at "
    "github.com/tilezen/joerd/blob/master/docs/attribution.md";

std::vector<std::uint8_t> read_file(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return {};
    return {std::istreambuf_iterator<char>(in), {}};
}

class TerrariumProvider final : public DemProvider {
public:
    explicit TerrariumProvider(std::string cache) : cache_(std::move(cache)) {}
    [[nodiscard]] std::string name() const override { return "terrarium"; }

    DemSampler open(const GeoBox& box, double cell_m) override {
        const double centre_lat = (box.south + box.north) / 2;
        const auto zoom = terrarium_zoom_for(cell_m / 2, centre_lat);
        const auto [px0, py0] = mercator_pixel(box.north, box.west, zoom);
        const auto [px1, py1] = mercator_pixel(box.south, box.east, zoom);
        // One pixel of margin so bilinear sampling at the box edge has neighbours.
        const auto x0 = static_cast<std::uint32_t>(std::floor((px0 - 1) / kTile)), y0 = static_cast<std::uint32_t>(std::floor((py0 - 1) / kTile));
        const auto x1 = static_cast<std::uint32_t>(std::floor((px1 + 1) / kTile)), y1 = static_cast<std::uint32_t>(std::floor((py1 + 1) / kTile));
        const auto nx = x1 - x0 + 1, ny = y1 - y0 + 1;
        if (nx * ny > 64) throw DemUnavailable("the district needs more than 64 terrain tiles; raise environment.grid_cell_m");

        const std::filesystem::path root = std::filesystem::path(cache_) / "terrarium" / std::to_string(zoom);
        const auto tile_path = [&](std::uint32_t x, std::uint32_t y) { return root / std::to_string(x) / (std::to_string(y) + ".png"); };
        bool missing = false;
        for (auto x = x0; x <= x1; ++x)
            for (auto y = y0; y <= y1; ++y) missing = missing || !std::filesystem::is_regular_file(tile_path(x, y));
        bool fetched = false;
        if (missing) {
            fetch(zoom, x0, y0, x1, y1);
            fetched = true;
        }

        auto mosaic = std::make_shared<std::vector<float>>(std::size_t(nx) * kTile * ny * kTile);
        const std::size_t mosaic_width = std::size_t(nx) * kTile;
        for (auto x = x0; x <= x1; ++x)
            for (auto y = y0; y <= y1; ++y) {
                RgbImage image;
                try {
                    image = decode_png(read_file(tile_path(x, y)));
                } catch (const PngError&) {
                    // A corrupt cache entry is worse than none: drop it and fetch once more.
                    std::error_code ec;
                    std::filesystem::remove(tile_path(x, y), ec);
                    fetch(zoom, x, y, x, y);
                    try {
                        image = decode_png(read_file(tile_path(x, y)));
                    } catch (const PngError& again) {
                        throw DemUnavailable("terrain tile " + std::to_string(zoom) + "/" + std::to_string(x) + "/" + std::to_string(y) +
                                             " is unreadable: " + again.what());
                    }
                }
                if (image.width != kTile || image.height != kTile) throw DemUnavailable("terrain tile has unexpected dimensions");
                for (std::uint32_t r = 0; r < kTile; ++r)
                    for (std::uint32_t c = 0; c < kTile; ++c) {
                        const auto* p = &image.rgb[(std::size_t(r) * kTile + c) * 3];
                        const auto mx = std::size_t(x - x0) * kTile + c, my = std::size_t(y - y0) * kTile + r;
                        (*mosaic)[my * mosaic_width + mx] = static_cast<float>(terrarium_elevation(p[0], p[1], p[2]));
                    }
            }

        DemSampler sampler;
        const double ox = double(x0) * kTile, oy = double(y0) * kTile;
        const auto width = nx * kTile, height = ny * kTile;
        sampler.elevation = [mosaic, ox, oy, width, height, zoom](double lat, double lon, double, double) {
            auto [px, py] = mercator_pixel(lat, lon, zoom);
            // Pixel centres sit at +0.5.
            double u = std::clamp(px - ox - 0.5, 0.0, width - 1.0), v = std::clamp(py - oy - 0.5, 0.0, height - 1.0);
            const auto i0 = static_cast<std::size_t>(u), j0 = static_cast<std::size_t>(v);
            const auto i1 = std::min<std::size_t>(i0 + 1, width - 1), j1 = std::min<std::size_t>(j0 + 1, height - 1);
            const double fu = u - i0, fv = v - j0;
            const auto& m = *mosaic;
            const double a = m[j0 * width + i0], b = m[j0 * width + i1], c = m[j1 * width + i0], d = m[j1 * width + i1];
            return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
        };
        auto& p = sampler.provenance;
        p.source = "terrarium";
        p.provider = "AWS Open Data Terrain Tiles";
        p.dataset = "Mapzen/Tilezen Terrarium (SRTM, GMTED2010, ETOPO1, 3DEP and regional sources)";
        p.licence = "Free use with attribution; public-domain and CC-BY sources";
        p.attribution = kTerrariumAttribution;
        p.zoom = zoom;
        p.native_resolution_m = kEquatorMetresPerPixelZ0 * std::cos(centre_lat * kPi / 180) / double(1u << zoom);
        p.south = box.south;
        p.west = box.west;
        p.north = box.north;
        p.east = box.east;
        p.cache_id = "terrarium/" + std::to_string(zoom) + "/" + std::to_string(x0) + "-" + std::to_string(x1) + "/" +
                     std::to_string(y0) + "-" + std::to_string(y1);
        p.fetched_at = fetched_at(zoom, x0, y0, x1, y1);
        p.note = fetched ? "downloaded" : "cache hit";
        p.observed = true;
        return sampler;
    }

private:
    void fetch(std::uint32_t zoom, std::uint32_t x0, std::uint32_t y0, std::uint32_t x1, std::uint32_t y1) const {
        const auto script = find_helper_script("fetch_dem.py");
        if (script.empty()) throw DemUnavailable("the terrain downloader scripts/fetch_dem.py was not found");
        std::ostringstream command;
        command << quote_argument(python_command()) << ' ' << quote_argument(script.string()) << " --zoom " << zoom << " --tiles "
                << x0 << ',' << y0 << ',' << x1 << ',' << y1 << " --cache " << quote_argument(cache_);
        std::string output;
        if (run_download_command(command.str(), output) != 0) {
            while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) output.pop_back();
            const auto line = output.substr(output.rfind('\n') == std::string::npos ? 0 : output.rfind('\n') + 1);
            throw DemUnavailable("terrain tiles could not be downloaded: " + (line.empty() ? std::string("unknown error") : line.substr(0, 300)));
        }
    }

    [[nodiscard]] std::string fetched_at(std::uint32_t zoom, std::uint32_t x0, std::uint32_t y0, std::uint32_t x1, std::uint32_t y1) const {
        try {
            std::ifstream in(std::filesystem::path(cache_) / "terrarium" / "manifest.json");
            if (!in) return "";
            const auto manifest = nlohmann::json::parse(in);
            std::string latest;
            for (auto x = x0; x <= x1; ++x)
                for (auto y = y0; y <= y1; ++y) {
                    const auto key = std::to_string(zoom) + "/" + std::to_string(x) + "/" + std::to_string(y);
                    if (manifest.contains("tiles") && manifest["tiles"].contains(key))
                        latest = std::max(latest, manifest["tiles"][key].value("fetched_at", std::string{}));
                }
            return latest;
        } catch (...) {
            return "";
        }
    }

    std::string cache_;
};

class FlatProvider final : public DemProvider {
public:
    FlatProvider(std::string note, bool degraded) : note_(std::move(note)), degraded_(degraded) {}
    [[nodiscard]] std::string name() const override { return "flat"; }
    DemSampler open(const GeoBox& box, double) override {
        DemSampler s;
        s.elevation = [](double, double, double, double) { return 0.0; };
        s.provenance.source = "flat";
        s.provenance.dataset = "none";
        s.provenance.note = note_;
        s.provenance.degraded = degraded_;
        s.provenance.south = box.south;
        s.provenance.west = box.west;
        s.provenance.north = box.north;
        s.provenance.east = box.east;
        return s;
    }

private:
    std::string note_;
    bool degraded_;
};

class SyntheticProvider final : public DemProvider {
public:
    SyntheticProvider(std::string spec, double cx, double cy, double half) : spec_(std::move(spec)), cx_(cx), cy_(cy), half_(half) {
        auto rest = spec_.substr(std::string("synthetic:").size());
        const auto colon = rest.find(':');
        shape_ = rest.substr(0, colon);
        if (colon != std::string::npos) parameter_ = std::strtod(rest.c_str() + colon + 1, nullptr);
        if (shape_ != "slope" && shape_ != "bowl" && shape_ != "hill" && shape_ != "valley")
            throw std::invalid_argument("unknown synthetic terrain: " + spec_);
        if (!parameter_) parameter_ = shape_ == "slope" ? 0.05 : shape_ == "bowl" ? 10 : shape_ == "hill" ? 30 : 15;
    }
    [[nodiscard]] std::string name() const override { return spec_; }
    DemSampler open(const GeoBox& box, double) override {
        DemSampler s;
        const auto shape = shape_;
        const double p = parameter_, cx = cx_, cy = cy_, half = std::max(1.0, half_);
        s.elevation = [shape, p, cx, cy, half](double, double, double x, double y) {
            const double dx = x - cx, dy = y - cy;
            if (shape == "slope") return 100.0 + p * dx;
            if (shape == "bowl") return 100.0 - p + p * (dx * dx + dy * dy) / (half * half);
            if (shape == "hill") return 100.0 + p * std::exp(-(dx * dx + dy * dy) / (2 * (half / 3) * (half / 3)));
            return 100.0 + p * std::abs(dx) / half;  // valley
        };
        s.provenance.source = "synthetic";
        s.provenance.dataset = spec_;
        s.provenance.note = "analytic test surface; not observed terrain";
        s.provenance.south = box.south;
        s.provenance.west = box.west;
        s.provenance.north = box.north;
        s.provenance.east = box.east;
        return s;
    }

private:
    std::string spec_, shape_;
    double parameter_{}, cx_, cy_, half_;
};

std::string resolve_source(const Scenario& scenario, const EnvironmentConfig& config) {
    if (config.dem_source != "auto") return config.dem_source;
    if (const char* forced = std::getenv("DSTNS_DEM_SOURCE"); forced && *forced && std::string(forced) != "auto") return forced;
    return scenario.config.osm_file.empty() ? "flat" : "terrarium";
}

std::string terrain_hash(const Terrain& t) {
    std::ostringstream o;
    o << "terrain/v1;" << t.provenance.source << ';' << t.provenance.dataset << ';' << t.grid.width << 'x' << t.grid.height << ';'
      << std::llround(t.grid.cell_m * 1000) << ';' << std::llround(t.grid.origin_x_m * 1000) << ',' << std::llround(t.grid.origin_y_m * 1000) << ';';
    for (const auto z : t.elevation_m) o << std::lround(z * 100) << ',';
    return "sha256:" + sha256(o.str());
}

} // namespace

std::pair<double, double> mercator_pixel(double lat, double lon, std::uint32_t zoom) {
    const double n = double(1u << zoom) * kTile;
    const double clamped = std::clamp(lat, -85.05112878, 85.05112878) * kPi / 180;
    return {(lon + 180.0) / 360.0 * n, (1.0 - std::asinh(std::tan(clamped)) / kPi) / 2.0 * n};
}

std::uint32_t terrarium_zoom_for(double metres, double latitude) {
    const double ground = kEquatorMetresPerPixelZ0 * std::max(0.05, std::cos(latitude * kPi / 180));
    for (std::uint32_t z = 10; z < 14; ++z)
        if (ground / double(1u << z) <= metres) return z;
    return 14;
}

std::unique_ptr<DemProvider> make_terrarium_provider(const std::string& cache_dir) { return std::make_unique<TerrariumProvider>(cache_dir); }
std::unique_ptr<DemProvider> make_flat_provider(std::string note, bool degraded) { return std::make_unique<FlatProvider>(std::move(note), degraded); }
std::unique_ptr<DemProvider> make_synthetic_provider(const std::string& spec, double cx, double cy, double half) {
    return std::make_unique<SyntheticProvider>(spec, cx, cy, half);
}

double Terrain::elevation_at(double x_m, double y_m) const {
    return elevation_m.empty() ? 0.0 : sample_bilinear(grid, elevation_m.data(), x_m, y_m);
}

std::pair<double, double> Terrain::gradient_at(double x_m, double y_m) const {
    if (dzdx.empty()) return {0, 0};
    return {sample_bilinear(grid, dzdx.data(), x_m, y_m), sample_bilinear(grid, dzdy.data(), x_m, y_m)};
}

LocalProjection scenario_projection(const Scenario& s) {
    if (s.projection_lat != 0 || s.projection_lon != 0) return {s.projection_lat, s.projection_lon};
    if (s.nodes.empty()) return {s.location_lat, s.location_lon};
    const auto& p = s.nodes.front().position;
    LocalProjection proj;
    proj.lat0 = p.lat - p.y_m / LocalProjection::kMetresPerDegree;
    proj.lon0 = p.lon - p.x_m / proj.metres_per_degree_lon();
    return proj;
}

GridSpec environment_grid(const Scenario& s, const EnvironmentConfig& c) {
    double lo_x = std::numeric_limits<double>::max(), lo_y = lo_x, hi_x = -lo_x, hi_y = -lo_x;
    const auto extend = [&](const Point& p) {
        lo_x = std::min(lo_x, p.x_m);
        lo_y = std::min(lo_y, p.y_m);
        hi_x = std::max(hi_x, p.x_m);
        hi_y = std::max(hi_y, p.y_m);
    };
    for (const auto& n : s.nodes) extend(n.position);
    for (const auto& f : s.features)
        for (const auto& p : f.geometry) extend(p);
    if (lo_x > hi_x) lo_x = hi_x = lo_y = hi_y = 0;
    const double margin = std::clamp(c.grid_margin_m, 0.0, 5000.0);
    lo_x -= margin;
    lo_y -= margin;
    hi_x += margin;
    hi_y += margin;
    double cell = std::clamp(c.grid_cell_m, 2.0, 1000.0);
    const auto budget = std::max<std::uint64_t>(16, c.max_grid_cells);
    GridSpec g;
    for (;;) {
        g.width = static_cast<std::uint32_t>(std::max(4.0, std::ceil((hi_x - lo_x) / cell)));
        g.height = static_cast<std::uint32_t>(std::max(4.0, std::ceil((hi_y - lo_y) / cell)));
        if (std::uint64_t(g.width) * g.height <= budget) break;
        cell *= 1.25;
    }
    g.cell_m = cell;
    // Centre the grid on the box so the margin is even on both sides.
    g.origin_x_m = (lo_x + hi_x) / 2 - g.width * cell / 2;
    g.origin_y_m = (lo_y + hi_y) / 2 - g.height * cell / 2;
    return g;
}

void smooth_binomial(const GridSpec& g, std::vector<float>& field) {
    const auto source = field;
    for (std::uint32_t j = 0; j < g.height; ++j)
        for (std::uint32_t i = 0; i < g.width; ++i) {
            double sum = 0, weight = 0;
            for (int dj = -1; dj <= 1; ++dj)
                for (int di = -1; di <= 1; ++di) {
                    const auto ii = std::clamp<std::int64_t>(std::int64_t(i) + di, 0, g.width - 1);
                    const auto jj = std::clamp<std::int64_t>(std::int64_t(j) + dj, 0, g.height - 1);
                    const double w = (di ? 1 : 2) * (dj ? 1 : 2);
                    sum += w * source[g.index(std::uint32_t(ii), std::uint32_t(jj))];
                    weight += w;
                }
            field[g.index(i, j)] = static_cast<float>(sum / weight);
        }
}

double fill_missing(const GridSpec& g, std::vector<float>& field) {
    std::size_t missing = 0;
    for (const auto z : field) missing += !std::isfinite(z);
    if (!missing) return 0;
    const double share = double(missing) / std::max<std::size_t>(1, field.size());
    for (std::uint32_t pass = 0; pass < g.width + g.height && missing; ++pass) {
        auto next = field;
        for (std::uint32_t j = 0; j < g.height; ++j)
            for (std::uint32_t i = 0; i < g.width; ++i) {
                const auto k = g.index(i, j);
                if (std::isfinite(field[k])) continue;
                double sum = 0;
                int n = 0;
                const auto take = [&](std::size_t at) {
                    if (std::isfinite(field[at])) {
                        sum += field[at];
                        ++n;
                    }
                };
                if (i > 0) take(k - 1);
                if (i + 1 < g.width) take(k + 1);
                if (j > 0) take(k - g.width);
                if (j + 1 < g.height) take(k + g.width);
                if (n) {
                    next[k] = static_cast<float>(sum / n);
                    --missing;
                }
            }
        field.swap(next);
    }
    for (auto& z : field)
        if (!std::isfinite(z)) z = 0;
    return share;
}

void compute_gradient(Terrain& t) {
    const auto& g = t.grid;
    t.dzdx.assign(g.cells(), 0);
    t.dzdy.assign(g.cells(), 0);
    t.slope.assign(g.cells(), 0);
    for (std::uint32_t j = 0; j < g.height; ++j)
        for (std::uint32_t i = 0; i < g.width; ++i) {
            const auto k = g.index(i, j);
            const auto il = i > 0 ? i - 1 : i, ir = i + 1 < g.width ? i + 1 : i;
            const auto jd = j > 0 ? j - 1 : j, ju = j + 1 < g.height ? j + 1 : j;
            const double gx = (double(t.elevation_m[g.index(ir, j)]) - t.elevation_m[g.index(il, j)]) / ((ir - il) * g.cell_m);
            const double gy = (double(t.elevation_m[g.index(i, ju)]) - t.elevation_m[g.index(i, jd)]) / ((ju - jd) * g.cell_m);
            t.dzdx[k] = static_cast<float>(gx);
            t.dzdy[k] = static_cast<float>(gy);
            t.slope[k] = static_cast<float>(std::hypot(gx, gy));
        }
}

Terrain build_terrain(const Scenario& scenario, const EnvironmentConfig& config, DemProvider& provider) {
    Terrain t;
    t.grid = environment_grid(scenario, config);
    t.projection = scenario_projection(scenario);
    t.sea_mask_m = config.sea_mask_m;
    t.grade_baseline_m = config.grade_baseline_m;
    const auto [south, west] = t.projection.to_geo(t.grid.origin_x_m, t.grid.origin_y_m);
    const auto [north, east] = t.projection.to_geo(t.grid.origin_x_m + t.grid.width * t.grid.cell_m, t.grid.origin_y_m + t.grid.height * t.grid.cell_m);
    auto sampler = provider.open({south, west, north, east}, t.grid.cell_m);
    t.elevation_m.assign(t.grid.cells(), 0);
    for (std::uint32_t j = 0; j < t.grid.height; ++j)
        for (std::uint32_t i = 0; i < t.grid.width; ++i) {
            const double x = t.grid.centre_x(i), y = t.grid.centre_y(j);
            const auto [lat, lon] = t.projection.to_geo(x, y);
            const double z = sampler.elevation(lat, lon, x, y);
            t.elevation_m[t.grid.index(i, j)] = std::isfinite(z) && z > kLowestPlausibleM && z < kHighestPlausibleM
                                                    ? static_cast<float>(std::round(z * 100) / 100)
                                                    : std::numeric_limits<float>::quiet_NaN();
        }
    const double missing = fill_missing(t.grid, t.elevation_m);
    if (missing > 0.5) throw DemUnavailable("the terrain source has no data for most of the district");
    t.provenance = std::move(sampler.provenance);
    // Observed elevation models carry metres of vertical error (SRTM-derived
    // tiles are surface models with roughly 5 m of noise), which a 25 m grid
    // turns into spurious slopes. A binomial 3x3 pass per configured step
    // removes the cell-to-cell part of it; analytic surfaces are left exact.
    if (t.provenance.observed)
        for (std::uint32_t pass = 0; pass < config.dem_smoothing_passes; ++pass) smooth_binomial(t.grid, t.elevation_m);
    for (auto& z : t.elevation_m) z = static_cast<float>(std::round(z * 100) / 100);
    if (missing > 0) t.provenance.note += (t.provenance.note.empty() ? "" : "; ") + std::to_string(std::lround(missing * 100)) + "% of cells filled from neighbours";
    const auto [lo, hi] = std::minmax_element(t.elevation_m.begin(), t.elevation_m.end());
    t.min_m = *lo;
    t.max_m = *hi;
    compute_gradient(t);
    t.hash = terrain_hash(t);
    return t;
}

Terrain build_terrain(const Scenario& scenario, const EnvironmentConfig& config) {
    const auto source = resolve_source(scenario, config);
    const auto grid = environment_grid(scenario, config);
    std::unique_ptr<DemProvider> provider;
    // The server's --dem-cache (DSTNS_DEM_CACHE) places the cache for every run.
    const char* cache_override = std::getenv("DSTNS_DEM_CACHE");
    const std::string cache = cache_override && *cache_override ? cache_override : config.dem_cache_dir;
    if (source == "terrarium") provider = make_terrarium_provider(cache);
    else if (source == "flat") provider = make_flat_provider(config.dem_source == "flat" ? "configured" : scenario.config.osm_file.empty() ? "synthetic grid: no real terrain" : "DEM disabled", false);
    else if (source.rfind("synthetic:", 0) == 0)
        provider = make_synthetic_provider(source, grid.origin_x_m + grid.width * grid.cell_m / 2, grid.origin_y_m + grid.height * grid.cell_m / 2,
                                           std::min(grid.width, grid.height) * grid.cell_m / 2);
    else throw std::invalid_argument("unknown DEM source: " + source + " (auto, terrarium, flat or synthetic:<shape>)");
    try {
        return build_terrain(scenario, config, *provider);
    } catch (const DemUnavailable& e) {
        if (config.dem_required) throw;
        auto flat = make_flat_provider(std::string("fallback: ") + e.what(), true);
        auto t = build_terrain(scenario, config, *flat);
        return t;
    }
}

void apply_terrain(Scenario& s, const Terrain& t) {
    for (auto& n : s.nodes) n.elevation_m = std::round(t.elevation_at(n.position.x_m, n.position.y_m) * 100) / 100;
    // A DEM cannot resolve a slope over less than its own error allows: a 5 m
    // segment divided into a metre of DEM noise reads as a 20% wall. So the
    // rise is measured over a baseline of at least grade_baseline_m (and two
    // cells),
    // centred on the segment and along its direction; a long segment uses its
    // own endpoints. The baseline is symmetric, so a twin's grade is still the
    // exact negation of its own.
    const double baseline = std::max(t.grade_baseline_m, 2 * t.grid.cell_m);
    for (auto& e : s.edges) {
        if (e.from.value >= s.nodes.size() || e.to.value >= s.nodes.size()) continue;
        const auto& a = s.nodes[e.from.value].position;
        const auto& b = s.nodes[e.to.value].position;
        const double dx = b.x_m - a.x_m, dy = b.y_m - a.y_m, d = std::hypot(dx, dy);
        if (d < 1e-6) {
            e.grade = 0;
            continue;
        }
        double grade;
        if (d >= baseline) {
            grade = (s.nodes[e.to.value].elevation_m - s.nodes[e.from.value].elevation_m) / d;
        } else {
            const double mx = (a.x_m + b.x_m) / 2, my = (a.y_m + b.y_m) / 2, ux = dx / d * baseline / 2, uy = dy / d * baseline / 2;
            grade = (t.elevation_at(mx + ux, my + uy) - t.elevation_at(mx - ux, my - uy)) / baseline;
        }
        // The steepest public streets are about 35%; beyond that is an artefact.
        e.grade = std::clamp(grade, -kMaxRoadGrade, kMaxRoadGrade);
    }
}

} // namespace dstns::env
