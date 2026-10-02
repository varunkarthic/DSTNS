// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

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

// A snapshot of the download currently in flight, if any. The operator CLI
// polls this so a multi-minute city download is a progress bar rather than a
// silent wait; nothing in the simulation depends on it.
struct MapFetchStatus {
    bool active{};
    std::string city, country, phase, file;
    std::uintmax_t bytes{}, total{};
    double elapsed_s{};
};

[[nodiscard]] MapFetchStatus current_map_fetch();

// Cancel only the downloader process group owned by this server session.
void cancel_map_download();

// The helper-script machinery the map download uses, for other downloaders
// (terrain tiles): a script found beside the binary, the configured Python,
// and a child run in its own process group that cancel_map_download() stops.
[[nodiscard]] std::filesystem::path find_helper_script(const std::string& name);
[[nodiscard]] std::string python_command();
[[nodiscard]] std::string quote_argument(const std::string& value);
int run_download_command(const std::string& command, std::string& output);

// How the map cache is trimmed when the server boots.
enum class CachePolicy {
    Keep,   // never delete; the operator manages the directory
    Prune,  // keep the newest `keep` extracts, delete the rest
    Clear,  // delete every cached extract
};

[[nodiscard]] CachePolicy parse_cache_policy(const std::string& value);

struct CacheSweep {
    std::size_t removed{};
    std::size_t kept{};
    std::uintmax_t freed_bytes{};
};

// Trim the map cache. City extracts are large, and a long-lived install would
// otherwise accumulate one per city ever visited. Called once at startup.
CacheSweep sweep_map_cache(const std::filesystem::path& directory,
                           CachePolicy policy,
                           std::size_t keep = 1);

} // namespace dstns
