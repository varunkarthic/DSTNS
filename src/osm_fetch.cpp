// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/osm_fetch.hpp"

#include "dstns/utf8.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>
#include <mutex>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

#include <sys/wait.h>
#include <fcntl.h>
#include <spawn.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <thread>
extern char** environ;

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

// A private process group lets session termination stop the downloader and its
// descendants without touching the launcher's terminal or unrelated processes.
std::mutex child_mutex;
pid_t download_pid = 0;
bool download_cancelled = false;
int run_capture(const std::string& command, std::string& output) {
    output.clear();
    int pipefd[2];
    if (::pipe(pipefd) != 0) return -1;
    // Close-on-exec, so no other child this process starts (SUMO, say) holds
    // the write end open and keeps this read from ever seeing end of file.
    // The dup2 onto the downloader's stdout/stderr clears the flag there.
    ::fcntl(pipefd[0], F_SETFD, FD_CLOEXEC);
    ::fcntl(pipefd[1], F_SETFD, FD_CLOEXEC);
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDERR_FILENO);
    posix_spawn_file_actions_addclose(&actions, pipefd[0]);
    posix_spawn_file_actions_addclose(&actions, pipefd[1]);
    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&attr, 0);
    char* argv[] = {const_cast<char*>("sh"), const_cast<char*>("-c"), const_cast<char*>(command.c_str()), nullptr};
    pid_t pid = 0;
    int error;
    {
        std::lock_guard lock(child_mutex);
        error = download_cancelled ? ECANCELED : posix_spawnp(&pid, "sh", &actions, &attr, argv, environ);
        if (!error) download_pid = pid;
    }
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attr);
    ::close(pipefd[1]);
    if (error) { ::close(pipefd[0]); return -1; }
    std::array<char, 4096> buffer{};
    for (;;) {
        const auto n = ::read(pipefd[0], buffer.data(), buffer.size());
        if (n > 0) {
            output.append(buffer.data(), static_cast<std::size_t>(n));
            if (output.size() > 65536) output.erase(0, output.size() - 65536);
        } else if (n < 0 && errno == EINTR) continue;
        else break;
    }
    ::close(pipefd[0]);
    int status = 0;
    for (;;) {
        {
            std::lock_guard lock(child_mutex);
            const auto reaped = ::waitpid(pid, &status, WNOHANG);
            if (reaped == pid || (reaped < 0 && errno != EINTR)) {
                download_pid = 0;
                return reaped == pid && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
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
    // A child process may emit anything at all, including binary from a proxy
    // or a partial multi-byte character; the message is reported over JSON.
    return sanitize_message(joined, 600);
}

// The in-flight download, published for observability only. Guarded because the
// API thread reads it while the engine thread writes it.
std::mutex g_fetch_mutex;
MapFetchStatus g_fetch;
std::chrono::steady_clock::time_point g_started;

// Read the sidecar the Python downloader updates as bytes arrive.
void read_progress(MapFetchStatus& status) {
    std::ifstream in(status.file + ".progress");
    if (!in) return;
    std::string text((std::istreambuf_iterator<char>(in)), {});
    const auto number = [&](const char* key) -> std::uintmax_t {
        const auto at = text.find(key);
        if (at == std::string::npos) return 0;
        const auto colon = text.find(':', at);
        if (colon == std::string::npos) return 0;
        return std::strtoull(text.c_str() + colon + 1, nullptr, 10);
    };
    const auto phase_at = text.find("\"phase\"");
    if (phase_at != std::string::npos) {
        const auto open_quote = text.find('"', text.find(':', phase_at));
        const auto close_quote = text.find('"', open_quote + 1);
        if (open_quote != std::string::npos && close_quote != std::string::npos)
            status.phase = sanitize_message(text.substr(open_quote + 1, close_quote - open_quote - 1), 64);
    }
    status.bytes = number("\"bytes\"");
    status.total = number("\"total\"");
}

} // namespace

void cancel_map_download() {
    std::lock_guard lock(child_mutex);
    download_cancelled = true;
    if (download_pid > 0) {
        ::kill(-download_pid, SIGTERM);
        ::kill(-download_pid, SIGKILL);
    }
}

MapFetchStatus current_map_fetch() {
    std::lock_guard lock(g_fetch_mutex);
    auto copy = g_fetch;
    if (copy.active) {
        read_progress(copy);
        copy.elapsed_s = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - g_started).count();
    }
    return copy;
}

std::filesystem::path find_helper_script(const std::string& name) {
    for (const auto& prefix : {std::string("scripts/"), std::string("../scripts/"), std::string("/app/scripts/")}) {
        std::error_code ec;
        if (std::filesystem::is_regular_file(prefix + name, ec)) return prefix + name;
    }
    return {};
}

std::string python_command() { return python_interpreter(); }
std::string quote_argument(const std::string& value) { return shell_quote(value); }
int run_download_command(const std::string& command, std::string& output) { return run_capture(command, output); }

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
        throw MapFetchError("Cannot create map cache directory " + sanitize_message(cache_directory.string()) + ": " + sanitize_message(ec.message()));
    }

    const auto script = find_fetch_script();
    if (script.empty()) {
        throw MapFetchError("OSM downloader scripts/fetch_osm.py was not found; cannot download the map tile for "
                            + location.city + " (" + location.bbox() + ")");
    }

    {
        std::lock_guard lock(g_fetch_mutex);
        g_fetch = {true, location.city, location.country, "connect", target.string(), 0, 0, 0};
        g_started = std::chrono::steady_clock::now();
    }
    // Always clear the published status, however this call leaves.
    struct FetchGuard {
        ~FetchGuard() {
            std::lock_guard lock(g_fetch_mutex);
            g_fetch = {};
        }
    } guard;

    std::ostringstream command;
    command << shell_quote(python_interpreter()) << ' ' << shell_quote(script.string())
            // "--bbox=VALUE", not "--bbox VALUE": a southern-hemisphere box
            // starts with a minus sign, which argparse would read as an option
            // and so refuse to download a seventh of the cities in the catalogue.
            << " --bbox=" << shell_quote(location.bbox())
            << " --output=" << shell_quote(target.string());

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
                            + sanitize_message(target.string()));
    }
    const auto size = std::filesystem::file_size(target, ec);
    if (ec || size < kMinimumTileBytes) {
        std::filesystem::remove(target, ec);
        throw MapFetchError("OSM download for " + location.city + " returned an implausibly small map ("
                            + std::to_string(size) + " bytes); Overpass is likely rate limiting this host");
    }
    return {target, true, size};
}

CachePolicy parse_cache_policy(const std::string& value) {
    if (value == "keep") return CachePolicy::Keep;
    if (value == "clear") return CachePolicy::Clear;
    if (value == "prune") return CachePolicy::Prune;
    throw std::invalid_argument("map.cache_policy must be keep, prune or clear");
}

CacheSweep sweep_map_cache(const std::filesystem::path& directory, CachePolicy policy, std::size_t keep) {
    CacheSweep result;
    std::error_code ec;
    if (policy == CachePolicy::Keep || !std::filesystem::is_directory(directory, ec)) return result;
    if (policy == CachePolicy::Clear) keep = 0;

    // Newest first, by last write time. Each extract is one .osm.xml plus an
    // optional sidecar manifest, which follows its extract.
    struct Entry { std::filesystem::path file; std::filesystem::file_time_type age; std::uintmax_t bytes; };
    std::vector<Entry> entries;
    for (const auto& item : std::filesystem::directory_iterator(directory, ec)) {
        if (ec) break;
        const auto& path = item.path();
        if (!item.is_regular_file(ec)) continue;
        // ".osm.xml" — extension() only yields ".xml", so match the stem too.
        if (path.extension() != ".xml" || path.stem().extension() != ".osm") continue;
        entries.push_back({path, std::filesystem::last_write_time(path, ec), std::filesystem::file_size(path, ec)});
    }
    std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) { return a.age > b.age; });

    for (std::size_t i = 0; i < entries.size(); ++i) {
        if (i < keep) { ++result.kept; continue; }
        const auto manifest = entries[i].file.parent_path()
            / (entries[i].file.stem().stem().string() + ".osm.manifest.json");
        std::filesystem::remove(manifest, ec);
        if (std::filesystem::remove(entries[i].file, ec)) {
            ++result.removed;
            result.freed_bytes += entries[i].bytes;
        }
    }
    // Interrupted downloads are never valid; drop them unconditionally, with
    // the progress sidecar a killed downloader had no chance to remove.
    // Collected first: removing entries mid-iteration is unspecified.
    std::vector<std::filesystem::path> leftovers;
    for (const auto& item : std::filesystem::directory_iterator(directory, ec)) {
        if (ec) break;
        const auto extension = item.path().extension();
        if (extension == ".part" || extension == ".progress") leftovers.push_back(item.path());
    }
    for (const auto& path : leftovers) std::filesystem::remove(path, ec);
    return result;
}

} // namespace dstns
