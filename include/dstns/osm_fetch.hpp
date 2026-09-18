#pragma once

#include "dstns/geo.hpp"

#include <filesystem>
#include <string>

namespace dstns {

struct MapTileResult {
    std::filesystem::path file;
    bool downloaded{false};  // false when an identical cached tile was reused.
    std::uintmax_t bytes{};
};

// Return a local OSM XML file for this tile, downloading it if necessary.
//
// A tile is identified entirely by MapLocation::cache_key(), so the same seed
// always resolves to the same file: a repeat run reuses the cache and performs
// no network I/O, while a re-rolled seed names a file that does not exist yet
// and therefore forces a fresh download.
//
// Throws MapFetchError when the tile is absent and cannot be downloaded. There
// is deliberately no fallback to a bundled map: a failed download must surface
// rather than silently change which map the seed denotes.
[[nodiscard]] MapTileResult acquire_map_tile(const MapLocation& location,
                                             const std::filesystem::path& cache_directory);

// Locate scripts/fetch_osm.py relative to the working directory or install
// root. Exposed so tests and diagnostics can report a missing fetcher clearly.
[[nodiscard]] std::filesystem::path find_fetch_script();

} // namespace dstns
