#include "dstns/geo.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <numbers>

namespace dstns {
namespace {

// Inner-urban boxes, not administrative boundaries: each one is dense enough
// that a tile taken anywhere inside it lands on a connected street network.
const std::vector<City> kCities{
    {"Tokyo",         "Japan",          35.650, 139.680, 35.740, 139.780},
    {"London",        "United Kingdom", 51.470,  -0.210, 51.550,   0.000},
    {"New York",      "United States",  40.700, -74.020, 40.800, -73.940},
    {"Paris",         "France",         48.830,   2.270, 48.890,   2.400},
    {"Berlin",        "Germany",        52.470,  13.320, 52.550,  13.470},
    {"Singapore",     "Singapore",       1.270, 103.790,  1.360, 103.890},
    {"Sydney",        "Australia",     -33.895, 151.185, -33.860, 151.225},
    {"Toronto",       "Canada",         43.645, -79.425, 43.700, -79.355},
    {"Mumbai",        "India",          18.955,  72.825, 19.045,  72.875},
    {"Seoul",         "South Korea",    37.500, 126.950, 37.580, 127.070},
    {"Sao Paulo",     "Brazil",        -23.600, -46.690, -23.530, -46.610},
    {"Cairo",         "Egypt",          30.020,  31.210, 30.090,  31.300},
    {"San Francisco", "United States",  37.750, -122.450, 37.800, -122.390},
    {"Amsterdam",     "Netherlands",    52.350,   4.850, 52.390,   4.930},
    {"Stockholm",     "Sweden",         59.312,  18.030, 59.350,  18.090},
    {"Dubai",         "UAE",            25.200,  55.265, 25.275,  55.335},
};

std::string trim_zeros(std::string value) {
    if (value.find('.') == std::string::npos) return value;
    while (!value.empty() && value.back() == '0') value.pop_back();
    if (!value.empty() && value.back() == '.') value.pop_back();
    return value;
}

std::string fixed6(double value) {
    char buffer[32];
    std::snprintf(buffer, sizeof buffer, "%.6f", value);
    return buffer;
}

} // namespace

const std::vector<City>& city_catalog() { return kCities; }

double metres_per_degree_lon(double latitude) {
    // Guard the poles so a degenerate cosine can never scale a span to zero.
    return kMetresPerDegreeLat * std::max(0.01, std::cos(latitude * std::numbers::pi / 180.0));
}

double MapLocation::min_lat() const { return anchor_lat - radius_m / kMetresPerDegreeLat; }
double MapLocation::max_lat() const { return anchor_lat + radius_m / kMetresPerDegreeLat; }
double MapLocation::min_lon() const { return anchor_lon - radius_m / metres_per_degree_lon(anchor_lat); }
double MapLocation::max_lon() const { return anchor_lon + radius_m / metres_per_degree_lon(anchor_lat); }

std::string MapLocation::bbox() const {
    return fixed6(min_lat()) + "," + fixed6(min_lon()) + "," + fixed6(max_lat()) + "," + fixed6(max_lon());
}

std::string MapLocation::cache_key() const {
    std::string slug;
    for (const char c : city) {
        if (c == ' ') slug.push_back('-');
        else if (std::isalnum(static_cast<unsigned char>(c))) slug.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return slug + "_" + trim_zeros(fixed6(anchor_lat)) + "_" + trim_zeros(fixed6(anchor_lon))
         + "_r" + std::to_string(static_cast<long long>(std::llround(radius_m)));
}

std::filesystem::path MapLocation::cache_path(const std::filesystem::path& directory) const {
    return directory / (cache_key() + ".osm.xml");
}

MapLocation select_map_location(Seed128 seed, double radius_m) {
    if (!(radius_m > 0.0) || radius_m > 20000.0) {
        throw std::invalid_argument("tile radius must be in (0, 20000] metres");
    }
    const DeterministicRng city_rng{seed.derive("map.city")};
    const auto& city = kCities.at(city_rng.bounded({RngDomain::MapSelection, 0, 0, 0},
                                                   static_cast<std::uint32_t>(kCities.size())));

    // The anchor ranges over the whole urban box. The tile is allowed to extend
    // past that box: the box marks where the dense core is, and a city does not
    // stop at its edge. Insetting instead would collapse the compact boxes to a
    // single point and make every seed for that city pick the same district.
    const DeterministicRng anchor_rng{seed.derive("map.anchor")};
    MapLocation location;
    location.city = city.name;
    location.country = city.country;
    location.anchor_lat = city.min_lat + (city.max_lat - city.min_lat) * anchor_rng.uniform01({RngDomain::MapSelection, 0, 1, 0});
    location.anchor_lon = city.min_lon + (city.max_lon - city.min_lon) * anchor_rng.uniform01({RngDomain::MapSelection, 0, 2, 0});
    location.radius_m = radius_m;
    return location;
}

} // namespace dstns
