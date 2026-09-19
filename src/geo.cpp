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

std::string City::slug() const {
    std::string out;
    for (const char c : name) {
        if (c == ' ') out.push_back('-');
        else if (std::isalnum(static_cast<unsigned char>(c)))
            out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return out;
}

const std::vector<City>& city_catalog() { return kCities; }

double metres_per_degree_lon(double latitude) {
    // Guard the poles so a degenerate cosine can never scale a span to zero.
    return kMetresPerDegreeLat * std::max(0.01, std::cos(latitude * std::numbers::pi / 180.0));
}

// The extract is a square of extent_m centred on the city, so its bounds depend
// only on the city and the extent. Every district of that city reads the same
// file.
double MapLocation::min_lat() const { return centre_lat - extent_m / 2 / kMetresPerDegreeLat; }
double MapLocation::max_lat() const { return centre_lat + extent_m / 2 / kMetresPerDegreeLat; }
double MapLocation::min_lon() const { return centre_lon - extent_m / 2 / metres_per_degree_lon(centre_lat); }
double MapLocation::max_lon() const { return centre_lon + extent_m / 2 / metres_per_degree_lon(centre_lat); }

std::string MapLocation::bbox() const {
    return fixed6(min_lat()) + "," + fixed6(min_lon()) + "," + fixed6(max_lat()) + "," + fixed6(max_lon());
}

std::string MapLocation::cache_key() const {
    std::string slug;
    for (const char c : city) {
        if (c == ' ') slug.push_back('-');
        else if (std::isalnum(static_cast<unsigned char>(c)))
            slug.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return slug + "_x" + std::to_string(static_cast<long long>(std::llround(extent_m)));
}

std::filesystem::path MapLocation::cache_path(const std::filesystem::path& directory) const {
    return directory / (cache_key() + ".osm.xml");
}

MapLocation select_map_location(Seed128 seed, double extent_m) {
    if (!(extent_m >= 500.0) || extent_m > 20000.0) {
        throw std::invalid_argument("city extract extent must be in [500, 20000] metres");
    }
    const DeterministicRng city_rng{seed.derive("map.city")};
    const auto& city = kCities.at(city_rng.bounded({RngDomain::MapSelection, 0, 0, 0},
                                                   static_cast<std::uint32_t>(kCities.size())));

    MapLocation location;
    location.city = city.name;
    location.country = city.country;
    location.extent_m = extent_m;
    location.centre_lat = city.centre_lat();
    location.centre_lon = city.centre_lon();

    // The anchor ranges over the extract, inset by a quarter so a district grown
    // around it stays largely inside the downloaded area instead of running off
    // the edge. Different seeds for one city therefore pick genuinely different
    // districts of the same file.
    const DeterministicRng anchor_rng{seed.derive("map.anchor")};
    const double lat_span = (location.max_lat() - location.min_lat()) * 0.5;
    const double lon_span = (location.max_lon() - location.min_lon()) * 0.5;
    location.anchor_lat = location.centre_lat - lat_span / 2
        + lat_span * anchor_rng.uniform01({RngDomain::MapSelection, 0, 1, 0});
    location.anchor_lon = location.centre_lon - lon_span / 2
        + lon_span * anchor_rng.uniform01({RngDomain::MapSelection, 0, 2, 0});
    return location;
}

} // namespace dstns
