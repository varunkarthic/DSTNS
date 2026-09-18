// Map sourcing invariants: the seed decides which real place is simulated, the
// tile is fetched on demand and cached by that seed-derived identity, and the
// resulting graph is stored in true metres.
#include "dstns/geo.hpp"
#include "dstns/osm.hpp"
#include "dstns/osm_fetch.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numbers>
#include <set>
#include <stdexcept>
#include <string>

using namespace dstns;

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

// Ground-truth distance between two coordinates, independent of the projection
// under test: the haversine great-circle distance on a spherical earth.
double haversine_m(double lat1, double lon1, double lat2, double lon2) {
    constexpr double radius = 6371008.8;
    const double to_rad = std::numbers::pi / 180.0;
    const double dlat = (lat2 - lat1) * to_rad, dlon = (lon2 - lon1) * to_rad;
    const double a = std::sin(dlat / 2) * std::sin(dlat / 2)
                   + std::cos(lat1 * to_rad) * std::cos(lat2 * to_rad) * std::sin(dlon / 2) * std::sin(dlon / 2);
    return 2 * radius * std::asin(std::min(1.0, std::sqrt(a)));
}

int main() {
    try {
        // ---- Seed determines the place, and does so reproducibly ----------
        const auto seed = Seed128::parse("0x5089050192221083c848bf3e12e22a4f");
        const auto first = select_map_location(seed);
        const auto again = select_map_location(seed);
        check(first.city == again.city && first.anchor_lat == again.anchor_lat
                  && first.anchor_lon == again.anchor_lon,
              "one seed always resolves to one location");
        check(first.cache_key() == again.cache_key(), "one seed always names one cache file");

        // ---- Re-rolling the seed genuinely moves the map ------------------
        std::set<std::string> cities, keys;
        for (unsigned i = 0; i < 200; ++i) {
            const auto location = select_map_location(Seed128::parse("0x" + std::to_string(i + 1) + "a5f"));
            cities.insert(location.city);
            keys.insert(location.cache_key());
        }
        check(cities.size() >= 8, "seeds spread across the city catalog");
        check(keys.size() >= 195, "distinct seeds name distinct tiles, so a re-roll forces a new download");

        // ---- The anchor always sits inside its city's urban box -----------
        for (unsigned i = 0; i < 300; ++i) {
            const auto location = select_map_location(Seed128::parse("0x" + std::to_string(i * 7 + 3) + "beef"));
            const City* city = nullptr;
            for (const auto& candidate : city_catalog())
                if (candidate.name == location.city) city = &candidate;
            check(city != nullptr, "resolved city is in the catalog");
            check(location.anchor_lat >= city->min_lat && location.anchor_lat <= city->max_lat,
                  "anchor latitude stays inside the urban box");
            check(location.anchor_lon >= city->min_lon && location.anchor_lon <= city->max_lon,
                  "anchor longitude stays inside the urban box");
        }

        // ---- The requested tile really is the requested size in metres ----
        for (const double radius : {500.0, 2000.0, 5000.0}) {
            for (const auto& city : city_catalog()) {
                MapLocation tile;
                tile.city = city.name;
                tile.anchor_lat = (city.min_lat + city.max_lat) / 2;
                tile.anchor_lon = (city.min_lon + city.max_lon) / 2;
                tile.radius_m = radius;
                const double north = haversine_m(tile.anchor_lat, tile.anchor_lon, tile.max_lat(), tile.anchor_lon);
                const double east = haversine_m(tile.anchor_lat, tile.anchor_lon, tile.anchor_lat, tile.max_lon());
                check(std::abs(north - radius) < radius * 0.01, "tile half-height matches the requested metres");
                check(std::abs(east - radius) < radius * 0.01, "tile half-width matches the requested metres");
            }
        }

        // ---- Cache keys are filesystem safe ------------------------------
        for (const auto& city : city_catalog()) {
            MapLocation tile;
            tile.city = city.name;
            tile.anchor_lat = city.min_lat;
            tile.anchor_lon = city.min_lon;
            tile.radius_m = 2000;
            const auto key = tile.cache_key();
            check(!key.empty(), "cache key is never empty");
            check(key.find('/') == std::string::npos && key.find(' ') == std::string::npos,
                  "cache key contains no path separators or spaces");
        }

        // ---- A cached tile is reused, with no network access -------------
        const auto sandbox = std::filesystem::temp_directory_path() / "dstns-map-sourcing";
        std::filesystem::remove_all(sandbox);
        std::filesystem::create_directories(sandbox);
        {
            const auto planted = first.cache_path(sandbox);
            std::ofstream out(planted);
            out << "<osm>" << std::string(8192, ' ') << "</osm>";
        }
        // Any download attempt now would fail, proving the cache was used.
        ::setenv("DSTNS_PYTHON", "/usr/bin/false", 1);
        const auto reused = acquire_map_tile(first, sandbox);
        check(!reused.downloaded, "an identical cached tile is reused instead of re-downloaded");
        check(reused.file == first.cache_path(sandbox), "the reused tile is the seed-derived file");

        // ---- A failed download is a hard error, never a silent fallback ---
        const auto missing = select_map_location(Seed128::parse("0xdeadbeefcafe"));
        bool raised = false;
        try {
            (void)acquire_map_tile(missing, sandbox);
        } catch (const MapFetchError& error) {
            raised = true;
            const std::string message = error.what();
            check(message.find(missing.city) != std::string::npos,
                  "the failure message names the city that could not be downloaded");
        }
        check(raised, "a failed download raises MapFetchError rather than substituting another map");
        check(!std::filesystem::exists(missing.cache_path(sandbox)),
              "a failed download leaves no partial file behind to poison the cache");
        ::unsetenv("DSTNS_PYTHON");

        // ---- A truncated cache entry is discarded, not trusted ------------
        {
            const auto stub = missing.cache_path(sandbox);
            std::ofstream out(stub);
            out << "<osm/>";
        }
        ::setenv("DSTNS_PYTHON", "/usr/bin/false", 1);
        bool rejected = false;
        try {
            (void)acquire_map_tile(missing, sandbox);
        } catch (const MapFetchError&) {
            rejected = true;
        }
        check(rejected, "a truncated cache entry is re-fetched rather than loaded as a map");
        ::unsetenv("DSTNS_PYTHON");
        std::filesystem::remove_all(sandbox);

        // ---- The graph is stored at true scale ---------------------------
        // Every node position must be the real metre offset from the projection
        // origin, so a kilometre on the ground is 1000.0 in the model.
        const auto graph = OsmRoadLoader{}.load_xml("data/fixtures/real_network.osm.xml", 50000,
                                                    DeterministicRng(seed.derive("map")));
        check(graph.nodes.size() >= 100, "fixture yields a usable network");
        double worst = 0;
        std::size_t compared = 0;
        for (std::size_t i = 0; i + 1 < graph.nodes.size() && compared < 2000; i += 7, ++compared) {
            const auto& a = graph.nodes[i].position;
            const auto& b = graph.nodes[i + 1].position;
            const double truth = haversine_m(a.lat, a.lon, b.lat, b.lon);
            const double modelled = std::hypot(b.x_m - a.x_m, b.y_m - a.y_m);
            if (truth > 50.0) worst = std::max(worst, std::abs(modelled - truth) / truth);
        }
        check(compared > 100, "enough node pairs compared");
        check(worst < 0.01, "modelled distances match ground truth within 1%");

        // Edge lengths are metres too: a road's stored length must agree with
        // the metre geometry it was built from.
        double edge_worst = 0;
        std::size_t edges_checked = 0;
        for (const auto& e : graph.edges) {
            if (e.geometry.size() < 2 || e.length_m < 50) continue;
            double walked = 0;
            for (std::size_t i = 1; i < e.geometry.size(); ++i)
                walked += std::hypot(e.geometry[i].x_m - e.geometry[i - 1].x_m,
                                     e.geometry[i].y_m - e.geometry[i - 1].y_m);
            edge_worst = std::max(edge_worst, std::abs(walked - e.length_m) / e.length_m);
            if (++edges_checked > 2000) break;
        }
        check(edges_checked > 50, "enough edges checked");
        check(edge_worst < 0.01, "edge length_m equals the walked metre geometry within 1%");

        std::cout << "Map sourcing: " << cities.size() << " cities reachable, "
                  << "scale error " << worst * 100 << "% (nodes) / "
                  << edge_worst * 100 << "% (edges)\n";
        std::cout << "Map sourcing invariants passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
