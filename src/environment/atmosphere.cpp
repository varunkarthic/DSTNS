// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/atmosphere.hpp"

#include "dstns/environment/raster.hpp"
#include "dstns/environment/terrain.hpp"
#include "dstns/rng.hpp"
#include "dstns/scenario.hpp"

#include <algorithm>
#include <array>
#include <barrier>
#include <cmath>
#include <thread>

namespace dstns::env {
namespace {
constexpr double kPi = 3.141592653589793;
constexpr double kGravity = 9.81;
constexpr double kKarman = 0.41;

// D3Q19: rest, six faces, twelve edges.
constexpr int kQ = 19;
constexpr std::array<int, kQ> kCx{0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0};
constexpr std::array<int, kQ> kCy{0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1};
constexpr std::array<int, kQ> kCz{0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1};
constexpr std::array<float, kQ> kW{1.f / 3,  1.f / 18, 1.f / 18, 1.f / 18, 1.f / 18, 1.f / 18, 1.f / 18,
                                   1.f / 36, 1.f / 36, 1.f / 36, 1.f / 36, 1.f / 36, 1.f / 36,
                                   1.f / 36, 1.f / 36, 1.f / 36, 1.f / 36, 1.f / 36, 1.f / 36};

constexpr int find(int cx, int cy, int cz) {
    for (int q = 0; q < kQ; ++q)
        if (kCx[q] == cx && kCy[q] == cy && kCz[q] == cz) return q;
    return -1;
}
constexpr std::array<int, kQ> make_opposite() {
    std::array<int, kQ> o{};
    for (int q = 0; q < kQ; ++q) o[q] = find(-kCx[q], -kCy[q], -kCz[q]);
    return o;
}
constexpr std::array<int, kQ> make_mirror() {
    std::array<int, kQ> o{};
    for (int q = 0; q < kQ; ++q) o[q] = find(kCx[q], kCy[q], -kCz[q]);
    return o;
}
constexpr auto kOpposite = make_opposite();
constexpr auto kMirror = make_mirror();

inline void equilibrium(float rho, float ux, float uy, float uz, float* feq) {
    const float usq = 1.5f * (ux * ux + uy * uy + uz * uz);
    for (int q = 0; q < kQ; ++q) {
        const float cu = 3.0f * (kCx[q] * ux + kCy[q] * uy + kCz[q] * uz);
        feq[q] = kW[q] * rho * (1.0f + cu + 0.5f * cu * cu - usq);
    }
}

double normal(const DeterministicRng& rng, std::uint64_t object) {
    const double u1 = std::max(1e-12, rng.uniform01({RngDomain::Atmosphere, object, 0, 0}));
    const double u2 = rng.uniform01({RngDomain::Atmosphere, object, 1, 0});
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(2 * kPi * u2);
}

double wrap_deg(double d) {
    d = std::fmod(d, 360.0);
    return d < 0 ? d + 360.0 : d;
}

double ring_area(const std::vector<Point>& ring) {
    double a = 0;
    for (std::size_t i = 0, n = ring.size(); i < n; ++i) {
        const auto& p = ring[i];
        const auto& q = ring[(i + 1) % n];
        a += p.x_m * q.y_m - q.x_m * p.y_m;
    }
    return std::abs(a) / 2;
}

double leading_number(const std::string& s, std::size_t* used) {
    try {
        return std::stod(s, used);
    } catch (...) {
        *used = 0;
        return 0;
    }
}
} // namespace

double log_profile(double z, double z0, double reference) {
    z0 = std::max(1e-3, z0);
    return std::log((std::max(0.0, z) + z0) / z0) / std::log((reference + z0) / z0);
}

double building_height(const std::map<std::string, std::string>& tags, const AtmosphereParams& p, std::string* source) {
    const auto set = [&](const char* s) {
        if (source) *source = s;
    };
    if (const auto it = tags.find("height"); it != tags.end()) {
        std::size_t used = 0;
        const double v = leading_number(it->second, &used);
        if (used && v > 0 && v < 1000) {
            const auto rest = it->second.substr(used);
            const bool feet = rest.find('\'') != std::string::npos || rest.find("ft") != std::string::npos;
            set("height");
            return feet ? v * 0.3048 : v;
        }
    }
    if (const auto it = tags.find("building:levels"); it != tags.end()) {
        std::size_t used = 0;
        const double v = leading_number(it->second, &used);
        if (used && v > 0 && v < 300) {
            set("levels");
            return v * p.storey_m;
        }
    }
    set("estimated");
    const auto it = tags.find("building");
    const std::string kind = it == tags.end() ? "" : it->second;
    if (kind == "garage" || kind == "garages" || kind == "shed" || kind == "hut" || kind == "kiosk" || kind == "carport" ||
        kind == "roof" || kind == "toilets" || kind == "service")
        return p.small_height_m;
    if (kind == "house" || kind == "detached" || kind == "semidetached_house" || kind == "bungalow" || kind == "terrace" ||
        kind == "farm" || kind == "cabin")
        return p.house_height_m;
    return p.default_height_m;
}

UrbanCanopy build_canopy(const Scenario& s, const GridSpec& g, const AtmosphereParams& p) {
    UrbanCanopy c;
    const auto cells = g.cells();
    c.plan_fraction.assign(cells, 0);
    c.height_m.assign(cells, 0);
    // Footprints on a 5 m sub-grid, so a building smaller than a cell still
    // counts for the share of the cell it covers.
    const std::uint32_t sub = std::max(1u, static_cast<std::uint32_t>(std::lround(g.cell_m / 5.0)));
    GridSpec fine = g;
    fine.cell_m = g.cell_m / sub;
    fine.width = g.width * sub;
    fine.height = g.height * sub;
    const float share = 1.0f / float(sub * sub);
    std::vector<float> weighted(cells, 0);
    double footprint = 0;
    for (const auto& f : s.features) {
        const auto it = f.tags.find("building");
        if (!f.polygon || it == f.tags.end() || it->second == "no" || f.geometry.size() < 4) continue;
        std::string source;
        const double h = building_height(f.tags, p, &source);
        ++c.buildings;
        if (source == "height") ++c.height_tagged;
        else if (source == "levels") ++c.levels_tagged;
        else ++c.estimated;
        footprint += ring_area(f.geometry);
        c.max_height_m = std::max(c.max_height_m, h);
        rasterize_polygon(fine, f.geometry, [&](std::size_t k) {
            const auto i = std::uint32_t(k % fine.width) / sub, j = std::uint32_t(k / fine.width) / sub;
            const auto cell = g.index(i, j);
            c.plan_fraction[cell] += share;
            weighted[cell] += share * float(h);
        });
    }
    double built = 0, height_sum = 0;
    for (std::size_t k = 0; k < cells; ++k) {
        if (c.plan_fraction[k] > 0) c.height_m[k] = weighted[k] / c.plan_fraction[k];
        c.plan_fraction[k] = std::min(1.0f, c.plan_fraction[k]);
        built += c.plan_fraction[k];
        height_sum += double(c.plan_fraction[k]) * c.height_m[k];
    }
    c.built_fraction = cells ? built / double(cells) : 0;
    c.mean_height_m = built > 0 ? height_sum / built : 0;
    c.mean_footprint_m2 = c.buildings ? footprint / c.buildings : 0;
    return c;
}

WindClimate wind_climate(const Scenario& s, double latitude) {
    // The planetary wind belts (e.g. Wallace and Hobbs, Atmospheric Science,
    // ch. 7): trade winds from the north-east (south-east in the southern
    // hemisphere) below 30 degrees, westerlies to 60, polar easterlies beyond,
    // and light variable winds near the equator. Speeds are typical 10 m
    // means over land; winter is windier than summer.
    WindClimate w;
    const double a = std::abs(latitude);
    const bool north = latitude >= 0;
    const DeterministicRng rng(s.seed.derive("das.wind"));
    double from = 0;
    if (a < 8) {
        w.belt = "doldrums";
        w.mean_speed_mps = 2.5;
        from = 360 * rng.uniform01({RngDomain::Atmosphere, 10, 0, 0});
    } else if (a < 30) {
        w.belt = "trades";
        w.mean_speed_mps = 4.5;
        from = north ? 60 : 120;
    } else if (a < 60) {
        w.belt = "westerlies";
        w.mean_speed_mps = 4.2;
        from = north ? 250 : 290;
    } else {
        w.belt = "polar easterlies";
        w.mean_speed_mps = 4.0;
        from = north ? 80 : 100;
    }
    const int month = std::clamp(s.month, 1, 12);
    const bool winter = north ? (month <= 2 || month == 12) : (month >= 6 && month <= 8);
    const bool summer = north ? (month >= 6 && month <= 8) : (month <= 2 || month == 12);
    if (winter) w.mean_speed_mps *= 1.15;
    if (summer) w.mean_speed_mps *= 0.9;
    // The day: its own direction and strength, from the run's atmosphere stream.
    w.prevailing_from_deg = wrap_deg(from + 35 * normal(rng, 1));
    w.mean_speed_mps *= std::clamp(std::exp(0.3 * normal(rng, 2)), 0.5, 1.8);
    w.veer_deg = 10 + 15 * rng.uniform01({RngDomain::Atmosphere, 3, 0, 0});
    w.phase_h = 12 + 6 * rng.uniform01({RngDomain::Atmosphere, 4, 0, 0});
    return w;
}

BackgroundWind background_wind(const WindClimate& c, double solar_time_h) {
    // Daytime convection mixes faster air down: the surface wind peaks in the
    // mid-afternoon and is lightest before dawn.
    BackgroundWind b;
    b.speed_mps = c.mean_speed_mps * (1 + 0.25 * std::cos(2 * kPi * (solar_time_h - 14) / 24));
    b.from_deg = wrap_deg(c.prevailing_from_deg + c.veer_deg * std::sin(2 * kPi * (solar_time_h - c.phase_h) / 24));
    return b;
}

AtmosphereLattice build_lattice(const Terrain& t, const UrbanCanopy& canopy, const AtmosphereParams& p) {
    AtmosphereLattice L;
    const auto& g = t.grid;
    const auto side = std::max(g.width, g.height);
    L.factor = std::max(1u, (side + p.max_side_cells - 1) / p.max_side_cells);
    L.nx = std::max(4u, (g.width + L.factor - 1) / L.factor);
    L.ny = std::max(4u, (g.height + L.factor - 1) / L.factor);
    L.dx_m = g.cell_m * L.factor;
    L.columns = g;
    L.columns.cell_m = L.dx_m;
    L.columns.width = L.nx;
    L.columns.height = L.ny;
    const auto columns = std::size_t(L.nx) * L.ny;
    std::vector<double> elevation(columns, 0), fraction(columns, 0), height(columns, 0);
    std::vector<int> count(columns, 0);
    for (std::uint32_t j = 0; j < g.height; ++j)
        for (std::uint32_t i = 0; i < g.width; ++i) {
            const auto k = g.index(i, j);
            const auto c = std::size_t(j / L.factor) * L.nx + i / L.factor;
            elevation[c] += t.elevation_m.empty() ? 0 : t.elevation_m[k];
            if (!canopy.plan_fraction.empty()) {
                fraction[c] += canopy.plan_fraction[k];
                height[c] += canopy.plan_fraction[k] * canopy.height_m[k];
            }
            ++count[c];
        }
    double lowest = 1e30;
    for (std::size_t c = 0; c < columns; ++c) {
        if (count[c]) {
            elevation[c] /= count[c];
            height[c] = fraction[c] > 0 ? height[c] / fraction[c] : 0;
            fraction[c] /= count[c];
        }
        lowest = std::min(lowest, elevation[c]);
    }
    // Terrain as solid cells, rounded to whole layers. The domain reaches
    // `top_m` above the highest ground (and three building heights above the
    // tallest canopy); relief beyond what the layers allow is clipped.
    std::uint32_t highest = 0;
    std::vector<std::uint32_t> ground(columns, 0);
    for (std::size_t c = 0; c < columns; ++c) {
        ground[c] = static_cast<std::uint32_t>(std::lround((elevation[c] - lowest) / L.dx_m));
        highest = std::max(highest, ground[c]);
    }
    // The domain's height follows the district's tall buildings, not its one
    // tallest: a lone tower would otherwise double the lattice for nothing.
    std::vector<double> built_heights;
    for (std::size_t c = 0; c < columns; ++c)
        if (fraction[c] > 0) built_heights.push_back(height[c]);
    double tall = 0;
    if (!built_heights.empty()) {
        const auto at = built_heights.begin() + std::ptrdiff_t(0.95 * double(built_heights.size() - 1));
        std::nth_element(built_heights.begin(), at, built_heights.end());
        tall = *at;
    }
    const auto above = static_cast<std::uint32_t>(std::ceil(std::max(p.top_m, 3 * tall) / L.dx_m));
    L.nz = std::clamp(highest + above, p.min_layers, p.max_layers);
    const std::uint32_t max_ground = L.nz > 4 ? L.nz - 4 : 0;
    L.solid.assign(L.cells(), 0);
    L.ground.assign(columns, 0);
    L.canopy_k.assign(L.cells(), 0);
    L.ground_k.assign(columns, 0);
    L.z0_m.assign(columns, float(p.open_z0_m));
    L.displacement_m.assign(columns, 0);
    // The ground beneath the canopy is open ground: its wall drag in the first
    // fluid layer is the log law's, C_d = (kappa / ln(z1 / z0))^2.
    const double z1 = L.dx_m / 2;
    const double wall = std::pow(kKarman / std::log(z1 / p.open_z0_m), 2);
    for (std::uint32_t j = 0; j < L.ny; ++j)
        for (std::uint32_t i = 0; i < L.nx; ++i) {
            const auto c = std::size_t(j) * L.nx + i;
            const auto gk = std::min(ground[c], max_ground);
            L.ground[c] = static_cast<std::uint16_t>(gk);
            for (std::uint32_t k = 0; k < gk; ++k) L.solid[L.index(i, j, k)] = 1;
            L.ground_k[c] = float(wall);
            // Buildings: a distributed drag 0.5 C_d a |u| u with frontal area
            // density a = lambda_p / b (buildings of width b covering a share
            // lambda_p of the ground), over the part of each layer they fill.
            const double h = height[c], lp = fraction[c];
            if (lp > 0 && h > 0) {
                const double a = lp / p.building_width_m;
                for (std::uint32_t k = gk; k < L.nz; ++k) {
                    const double bottom = (k - gk) * L.dx_m, filled = std::clamp((h - bottom) / L.dx_m, 0.0, 1.0);
                    if (filled <= 0) break;
                    L.canopy_k[L.index(i, j, k)] = float(0.5 * p.canopy_drag * a * L.dx_m * filled);
                }
                // Rules of thumb for the roughness of an urban canopy (Grimmond
                // and Oke 1999): z0 ~ 0.1 H, d ~ 0.7 H once it is moderately dense.
                const double density = std::min(1.0, lp / 0.2);
                L.z0_m[c] = float(std::max(p.open_z0_m, 0.1 * h * density));
                L.displacement_m[c] = float(0.7 * h * density);
            }
        }
    return L;
}

WindSolution solve_wind(const AtmosphereLattice& L, const BackgroundWind& wind, const std::vector<float>& heating_k, double air_c,
                        const AtmosphereParams& p) {
    WindSolution out;
    out.solved_for = wind;
    const std::size_t N = L.cells(), columns = std::size_t(L.nx) * L.ny;
    if (!N) return out;
    const int nx = int(L.nx), ny = int(L.ny), nz = int(L.nz);

    // The inflow: a logarithmic profile over the district's mean roughness,
    // `lattice_top_speed` at the top, in the direction the wind blows to.
    double z0 = 0;
    for (const auto v : L.z0_m) z0 += v;
    z0 /= double(columns);
    const double top = (nz - 0.5) * L.dx_m;
    const double ref_lat = p.lattice_top_speed * log_profile(p.reference_height_m, z0, p.reference_height_m) / log_profile(top, z0, p.reference_height_m);
    const double rad = wind.from_deg * kPi / 180;
    const double ex = -std::sin(rad), ey = -std::cos(rad);
    std::vector<std::array<float, kQ>> inflow(static_cast<std::size_t>(nz));
    for (int k = 0; k < nz; ++k) {
        const double z = (k + 0.5) * L.dx_m;
        const double s = p.lattice_top_speed * log_profile(z, z0, p.reference_height_m) / log_profile(top, z0, p.reference_height_m);
        equilibrium(1.f, float(s * ex), float(s * ey), 0.f, inflow[k].data());
    }

    // Buoyancy: the street's heating relative to the district's mean, as a
    // Boussinesq acceleration g dT / T decaying with height, in lattice units
    // a dx (u_lat / u_phys)^2, bounded for the lattice's stability.
    std::vector<float> buoyancy(N, 0);
    if (heating_k.size() == columns) {
        double mean = 0;
        for (const auto h : heating_k) mean += h;
        mean /= double(columns);
        const double speed = std::max(p.min_scaling_speed_mps, wind.speed_mps);
        const double scale = L.dx_m * (ref_lat / speed) * (ref_lat / speed);
        for (int j = 0; j < ny; ++j)
            for (int i = 0; i < nx; ++i) {
                const auto c = std::size_t(j) * nx + i;
                const double dt = std::clamp(double(heating_k[c]) - mean, -15.0, 15.0);
                for (int k = L.ground[c]; k < nz; ++k) {
                    const double z = (k - L.ground[c] + 0.5) * L.dx_m;
                    const double a = kGravity * dt / (air_c + 273.15) * std::exp(-z / p.buoyancy_height_m) * scale;
                    buoyancy[L.index(i, j, k)] = float(std::clamp(a, -p.max_buoyancy_lattice, p.max_buoyancy_lattice));
                }
            }
    }

    // The sponge: a band at the open sides and top relaxing towards the inflow.
    std::vector<float> sponge(N, 0);
    for (int k = 0; k < nz; ++k)
        for (int j = 0; j < ny; ++j)
            for (int i = 0; i < nx; ++i) {
                const double d = std::min({i, nx - 1 - i, j, ny - 1 - j, nz - 1 - k});
                if (d < p.sponge_cells) sponge[L.index(i, j, k)] = float(0.5 * std::pow(1 - d / p.sponge_cells, 2));
            }

    // Cells whose every neighbour is fluid and inside the lattice, and the
    // index offset of each direction's neighbour.
    std::array<std::ptrdiff_t, kQ> offset{};
    for (int q = 0; q < kQ; ++q) offset[q] = (std::ptrdiff_t(kCz[q]) * ny + kCy[q]) * nx + kCx[q];
    std::vector<std::uint8_t> interior(N, 0);
    for (int k = 1; k + 1 < nz; ++k)
        for (int j = 1; j + 1 < ny; ++j)
            for (int i = 1; i + 1 < nx; ++i) {
                bool clear = true;
                for (int q = 0; q < kQ && clear; ++q) clear = !L.solid[L.index(i - kCx[q], j - kCy[q], k - kCz[q])];
                interior[L.index(i, j, k)] = clear;
            }

    std::vector<float> a(N * kQ), b(N * kQ);
    for (int k = 0; k < nz; ++k)
        for (int j = 0; j < ny; ++j)
            for (int i = 0; i < nx; ++i) {
                const auto x = L.index(i, j, k);
                for (int q = 0; q < kQ; ++q) a[std::size_t(q) * N + x] = inflow[k][q];
            }

    const auto iterations = static_cast<std::uint32_t>(
        std::clamp(std::lround(p.flow_throughs * std::max(nx, ny) / p.lattice_top_speed), 200L, 2000L));
    unsigned threads = p.threads ? p.threads : std::clamp(std::thread::hardware_concurrency(), 1u, 8u);
    const std::size_t rows = std::size_t(ny) * nz;
    threads = static_cast<unsigned>(std::min<std::size_t>(threads, rows));
    std::vector<float> change(threads, 0), mach(threads, 0);
    // The reported field is the mean over the last quarter of the iterations:
    // the resolved flow is unsteady (eddies shed from the canopy, sound waves
    // crossing the lattice), and a mean is what traffic and the observer need.
    const std::uint32_t average_from = iterations - iterations / 4;
    std::vector<double> mean_u(columns, 0), mean_v(columns, 0), mean_w(columns, 0);
    const float tau0 = float(p.tau0);
    const float smag = float(18.0 * std::sqrt(2.0) * p.smagorinsky * p.smagorinsky);

    const auto sweep = [&](const std::vector<float>& src_vector, std::vector<float>& dst_vector, std::size_t row_begin, std::size_t row_end,
                           bool last, bool average, unsigned id) {
        // Raw pointers, so the compiler knows a store into the lattice
        // cannot move any of the arrays it reads.
        const float* __restrict src = src_vector.data();
        float* __restrict dst = dst_vector.data();
        const std::uint8_t* __restrict solid = L.solid.data();
        const std::uint8_t* __restrict inner = interior.data();
        const std::uint16_t* __restrict ground = L.ground.data();
        const float* __restrict canopy = L.canopy_k.data();
        const float* __restrict wall = L.ground_k.data();
        const float* __restrict lift = buoyancy.data();
        const float* __restrict band = sponge.data();
        float f[kQ], feq[kQ], fshift[kQ];
        for (std::size_t r = row_begin; r < row_end; ++r) {
            const int j = int(r % ny), k = int(r / ny);
            for (int i = 0; i < nx; ++i) {
                const auto x = L.index(i, j, k);
                if (solid[x]) continue;
                // Pull streaming: away from the boundaries and the terrain,
                // straight from the neighbours.
                if (inner[x]) {
                    for (int q = 0; q < kQ; ++q) f[q] = src[std::size_t(q) * N + std::size_t(std::ptrdiff_t(x) - offset[q])];
                } else for (int q = 0; q < kQ; ++q) {
                    const int si = i - kCx[q], sj = j - kCy[q], sk = k - kCz[q];
                    if (si < 0 || sj < 0 || si >= nx || sj >= ny || sk >= nz) {
                        f[q] = inflow[std::min(k, nz - 1)][q];
                    } else if (sk < 0 || solid[L.index(si, sj, sk)]) {
                        // A wall: specular reflection off the ground or a
                        // terrace top when the source beside us is fluid
                        // (free slip; the log law supplies the friction),
                        // else bounce-back off a terrain step.
                        if (kCz[q] != 0 && !solid[L.index(si, sj, k)]) f[q] = src[std::size_t(kMirror[q]) * N + L.index(si, sj, k)];
                        else f[q] = src[std::size_t(kOpposite[q]) * N + x];
                    } else {
                        f[q] = src[std::size_t(q) * N + L.index(si, sj, sk)];
                    }
                }
                float rho = 0, jx = 0, jy = 0, jz = 0;
                for (int q = 0; q < kQ; ++q) {
                    rho += f[q];
                    jx += kCx[q] * f[q];
                    jy += kCy[q] * f[q];
                    jz += kCz[q] * f[q];
                }
                const float ux = jx / rho, uy = jy / rho, uz = jz / rho;
                equilibrium(rho, ux, uy, uz, feq);
                // Smagorinsky: the eddy viscosity from the local strain, via
                // the non-equilibrium momentum flux (Hou et al. 1996).
                float pxx = 0, pyy = 0, pzz = 0, pxy = 0, pxz = 0, pyz = 0;
                for (int q = 0; q < kQ; ++q) {
                    const float d = f[q] - feq[q];
                    pxx += kCx[q] * kCx[q] * d;
                    pyy += kCy[q] * kCy[q] * d;
                    pzz += kCz[q] * kCz[q] * d;
                    pxy += kCx[q] * kCy[q] * d;
                    pxz += kCx[q] * kCz[q] * d;
                    pyz += kCy[q] * kCz[q] * d;
                }
                const float pi = std::sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz));
                const float tau = 0.5f * (tau0 + std::sqrt(tau0 * tau0 + smag * pi / rho));
                // Forces by the exact difference method (Kupershtokh 2004):
                // buoyancy, then canopy and wall drag applied implicitly,
                // u' = (u + a) / (1 + k |u|), stable for any drag.
                const auto c = std::size_t(j) * nx + i;
                float k_drag = canopy[x] + (k == ground[c] ? wall[c] : 0.f);
                const float speed = std::sqrt(ux * ux + uy * uy + uz * uz);
                const bool forced = k_drag > 0 || lift[x] != 0;
                if (forced) {
                    const float damp = 1.0f / (1.0f + k_drag * speed);
                    equilibrium(rho, ux * damp, uy * damp, (uz + lift[x]) * damp, fshift);
                }
                if (average && k == ground[c]) {
                    // Each column's first fluid layer lies in exactly one
                    // row, so one thread adds to it, always in the same order.
                    mean_u[c] += ux;
                    mean_v[c] += uy;
                    mean_w[c] += uz;
                }
                const float s = band[x];
                const auto& bc = inflow[k];
                const float omega = 1.0f / tau;
                if (forced)
                    for (int q = 0; q < kQ; ++q) f[q] = f[q] - (f[q] - feq[q]) * omega + (fshift[q] - feq[q]);
                else
                    for (int q = 0; q < kQ; ++q) f[q] = f[q] - (f[q] - feq[q]) * omega;
                if (s > 0)
                    for (int q = 0; q < kQ; ++q) f[q] = (1 - s) * f[q] + s * bc[q];
                for (int q = 0; q < kQ; ++q) dst[std::size_t(q) * N + x] = f[q];
                if (last) {
                    // How much this iteration changed the velocity: the steadiness test.
                    float pr = 0, px = 0, py = 0;
                    for (int q = 0; q < kQ; ++q) {
                        const float v = src[std::size_t(q) * N + x];
                        pr += v;
                        px += kCx[q] * v;
                        py += kCy[q] * v;
                    }
                    change[id] = std::max(change[id], std::max(std::abs(px / pr - ux), std::abs(py / pr - uy)));
                    mach[id] = std::max(mach[id], speed * float(std::sqrt(3.0)));
                }
            }
        }
    };

    {
        std::barrier sync(static_cast<std::ptrdiff_t>(threads));
        const auto work = [&](unsigned id) {
            const std::size_t begin = rows * id / threads, end = rows * (id + 1) / threads;
            for (std::uint32_t it = 0; it < iterations; ++it) {
                const bool even = it % 2 == 0;
                sweep(even ? a : b, even ? b : a, begin, end, it + 1 == iterations, it >= average_from, id);
                sync.arrive_and_wait();
            }
        };
        std::vector<std::thread> pool;
        for (unsigned id = 1; id < threads; ++id) pool.emplace_back(work, id);
        work(0);
        for (auto& t : pool) t.join();
    }
    const auto& f = iterations % 2 == 0 ? a : b;
    out.iterations = iterations;
    out.last_change = *std::max_element(change.begin(), change.end()) / ref_lat;
    out.max_mach = *std::max_element(mach.begin(), mach.end());
    out.converged = out.last_change < 1e-3;

    // Near the surface: the first fluid layer's velocity, brought down to
    // the reference height by the log law over the column's roughness.
    out.u.assign(columns, 0);
    out.v.assign(columns, 0);
    out.w.assign(columns, 0);
    double density_error = 0;
    std::size_t fluid = 0;
    for (std::size_t x = 0; x < N; ++x) {
        if (L.solid[x]) continue;
        float rho = 0;
        for (int q = 0; q < kQ; ++q) rho += f[std::size_t(q) * N + x];
        density_error += std::abs(rho - 1.0);
        ++fluid;
    }
    out.mean_density_error = fluid ? density_error / double(fluid) : 0;
    const double samples = iterations - average_from;
    for (std::size_t c = 0; c < columns; ++c) {
        const double zc = L.dx_m / 2;
        const double r = log_profile(p.reference_height_m, L.z0_m[c], p.reference_height_m) / log_profile(zc, L.z0_m[c], p.reference_height_m);
        out.u[c] = float(mean_u[c] / samples / ref_lat * r);
        out.v[c] = float(mean_v[c] / samples / ref_lat * r);
        out.w[c] = float(mean_w[c] / samples / ref_lat);
    }
    return out;
}

} // namespace dstns::env
