#include "dstns/osm_fetch.hpp"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

#include <sys/wait.h>

namespace dstns {
namespace {

// Smallest plausible tile. Overpass answers a throttled or malformed request
// with a short XML document, which would otherwise be cached as a valid map.
constexpr std::uintmax_t kMinimumTileBytes = 4096;

std::string shell_quote(const std::string& value) {
    std::string quoted = "'";
    for (const char c : value) {
        if (c == '\'') quoted += "'\\''";
        else quoted.push_back(c);
    }
    quoted.push_back('\'');
    return quoted;
}

std::string python_interpreter() {
    if (const char* override = std::getenv("DSTNS_PYTHON"); override && *override) return override;
    return "python3";
}

// Run a command, capturing stdout and stderr together for the error message.
int run_capture(const std::string& command, std::string& output) {
    output.clear();
    std::FILE* pipe = ::popen((command + " 2>&1").c_str(), "r");
    if (!pipe) return -1;
    std::array<char, 512> buffer{};
    while (std::fgets(buffer.data(), static_cast<int>(buffer.size()), pipe)) output += buffer.data();
    const int status = ::pclose(pipe);
    return status == -1 ? -1 : (WIFEXITED(status) ? WEXITSTATUS(status) : -1);
}

// Keep only the last few lines: Overpass errors are terse, Python tracebacks are not.
std::string tail_lines(const std::string& text, std::size_t count) {
    std::vector<std::string> lines;
    std::istringstream stream(text);
    for (std::string line; std::getline(stream, line);) {
        if (!line.empty()) lines.push_back(line);
    }
    if (lines.size() > count) lines.erase(lines.begin(), lines.end() - static_cast<long>(count));
    std::string joined;
    for (const auto& line : lines) {
        if (!joined.empty()) joined += " | ";
        joined += line;
    }
    return joined;
}

} // namespace

std::filesystem::path find_fetch_script() {
    for (const auto* candidate : {"scripts/fetch_osm.py", "../scripts/fetch_osm.py", "/app/scripts/fetch_osm.py"}) {
        std::error_code ec;
        if (std::filesystem::is_regular_file(candidate, ec)) return candidate;
    }
    return {};
}

MapTileResult acquire_map_tile(const MapLocation& location, const std::filesystem::path& cache_directory) {
    const auto target = location.cache_path(cache_directory);
    std::error_code ec;

    // Cache hit: the seed names this exact tile and it is already on disk.
    if (std::filesystem::is_regular_file(target, ec)) {
        const auto size = std::filesystem::file_size(target, ec);
        if (!ec && size >= kMinimumTileBytes) return {target, false, size};
        // A truncated cache entry is worse than none; drop it and re-download.
        std::filesystem::remove(target, ec);
    }

    std::filesystem::create_directories(cache_directory, ec);
    if (ec) {
        throw MapFetchError("Cannot create map cache directory " + cache_directory.string() + ": " + ec.message());
    }

    const auto script = find_fetch_script();
    if (script.empty()) {
        throw MapFetchError("OSM downloader scripts/fetch_osm.py was not found; cannot download the map tile for "
                            + location.city + " (" + location.bbox() + ")");
    }

    std::ostringstream command;
    command << shell_quote(python_interpreter()) << ' ' << shell_quote(script.string())
            << " --bbox " << shell_quote(location.bbox())
            << " --output " << shell_quote(target.string());

    std::string output;
    const int status = run_capture(command.str(), output);
    if (status != 0) {
        std::filesystem::remove(target, ec);
        throw MapFetchError("OSM download failed for " + location.city + " (" + location.country + ") at "
                            + std::to_string(location.anchor_lat) + ", " + std::to_string(location.anchor_lon)
                            + ": " + (output.empty() ? "the downloader produced no output" : tail_lines(output, 3)));
    }

    if (!std::filesystem::is_regular_file(target, ec)) {
        throw MapFetchError("OSM download for " + location.city + " reported success but wrote no file to "
                            + target.string());
    }
    const auto size = std::filesystem::file_size(target, ec);
    if (ec || size < kMinimumTileBytes) {
        std::filesystem::remove(target, ec);
        throw MapFetchError("OSM download for " + location.city + " returned an implausibly small map ("
                            + std::to_string(size) + " bytes); Overpass is likely rate limiting this host");
    }
    return {target, true, size};
}

} // namespace dstns
