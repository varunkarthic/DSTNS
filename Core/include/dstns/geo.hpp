// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/rng.hpp"

#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace dstns {

// One urban centre the seed may resolve to.
//
// The catalogue is a wide, geographically spread list of cities whose centres
// are densely mapped in OpenStreetMap, so an extract taken around one lands on
// a connected street network. Only the centre is stored: the extract is a
// square of the configured extent around it, and the district anchor is drawn
// inside that square.
struct City {
    std::string name;
    std::string country;
    double lat{}, lon{};

    [[nodiscard]] double centre_lat() const { return lat; }
    [[nodiscard]] double centre_lon() const { return lon; }
    // Filesystem-safe identity, e.g. "san-francisco".
    [[nodiscard]] std::string slug() const;
};

// A seed's resolved place.
//
// The download unit is the *city extract*: one file per city covering its core,
// bounded by extent_m so it stays a sane size. The anchor is a point inside
// that extract which the road loader grows a district around. Re-rolling the
// seed therefore moves to a different district of the same already-downloaded
// city whenever the city is unchanged, and only crossing to a new city costs a
// download.
struct MapLocation {
    std::string city;
    std::string country;
    double anchor_lat{}, anchor_lon{};
    double extent_m{};                        // side of the square city extract
    double centre_lat{}, centre_lon{};        // centre of that extract

    [[nodiscard]] double min_lat() const;
    [[nodiscard]] double max_lat() const;
    [[nodiscard]] double min_lon() const;
    [[nodiscard]] double max_lon() const;
    // "south,west,north,east", the order Overpass expects.
    [[nodiscard]] std::string bbox() const;
    // The extract is shared by every district of this city, so its name depends
    // only on the city and the extent, never on the anchor.
    [[nodiscard]] std::string cache_key() const;
    [[nodiscard]] std::filesystem::path cache_path(const std::filesystem::path& directory) const;
};

// Raised when a map could not be obtained. The message is operator-facing and
// names the city, the coordinates and the underlying cause.
class MapFetchError : public std::runtime_error {
public:
    explicit MapFetchError(const std::string& what) : std::runtime_error(what) {}
};

// Every city a seed may resolve to, in a fixed order: the order is part of the
// selection, so changing it changes which city a seed picks and must come with
// a new map selection version.
[[nodiscard]] const std::vector<City>& city_catalog();

// Metres per degree of latitude, and of longitude at a given latitude. The
// simulation stores positions in true metres, so every conversion goes here.
inline constexpr double kMetresPerDegreeLat = 111320.0;
[[nodiscard]] double metres_per_degree_lon(double latitude);

// Deterministically resolve a seed to a city and an anchor inside it.
// derive("map.city") picks the metropolis; derive("map.anchor") picks the
// coordinates. extent_m bounds the downloaded extract around the city centre.
[[nodiscard]] MapLocation select_map_location(Seed128 seed, double extent_m = 5000.0);

} // namespace dstns
