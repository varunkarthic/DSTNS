#pragma once

#include "dstns/rng.hpp"

#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace dstns {

// One metropolitan area the seed may resolve to. The urban box is the part of
// the city worth simulating: dense enough that a district tile taken anywhere
// inside it still lands on a connected road network.
struct City {
    std::string name;
    std::string country;
    double min_lat{}, min_lon{}, max_lat{}, max_lon{};
};

// A concrete download target: one city, one anchor inside it, one tile radius.
// Two MapLocations with the same fields always produce the same bounding box,
// the same cache filename and therefore the same road graph.
struct MapLocation {
    std::string city;
    std::string country;
    double anchor_lat{}, anchor_lon{};
    double radius_m{};

    [[nodiscard]] double min_lat() const;
    [[nodiscard]] double max_lat() const;
    [[nodiscard]] double min_lon() const;
    [[nodiscard]] double max_lon() const;
    // "south,west,north,east", the order Overpass expects.
    [[nodiscard]] std::string bbox() const;
    // Stable, filesystem-safe identity for this tile, e.g. "berlin_52.498100_13.441200_r2500".
    [[nodiscard]] std::string cache_key() const;
    [[nodiscard]] std::filesystem::path cache_path(const std::filesystem::path& directory) const;
};

// Raised when a tile could not be obtained. The message is operator-facing and
// names the city, the coordinates and the underlying cause.
class MapFetchError : public std::runtime_error {
public:
    explicit MapFetchError(const std::string& what) : std::runtime_error(what) {}
};

[[nodiscard]] const std::vector<City>& city_catalog();

// Metres per degree of latitude, and of longitude at a given latitude. The
// simulation stores positions in true metres, so every conversion goes here.
inline constexpr double kMetresPerDegreeLat = 111320.0;
[[nodiscard]] double metres_per_degree_lon(double latitude);

// Deterministically resolve a seed to a city and an anchor inside it.
// derive("map.city") picks the metropolis; derive("map.anchor") picks the
// coordinates. The same seed always yields the same location, and a different
// seed almost always yields a different one, so regenerating the graph after a
// re-roll genuinely requires a new download.
[[nodiscard]] MapLocation select_map_location(Seed128 seed, double radius_m = 2500.0);

} // namespace dstns
