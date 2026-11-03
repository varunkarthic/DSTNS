// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/osm_fetch.hpp"

#include "dstns/utf8.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>
#include <vector>

#include <zlib.h>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

#include <sys/wait.h>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <thread>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
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

// A gzip file into place: written beside the target and renamed, so that a failure leaves nothing half-written.
// Returns the bytes written, or 0 if it could not be read whole.
std::uintmax_t unpack(const std::filesystem::path& packed, const std::filesystem::path& target) {
    constexpr std::uintmax_t kLimit = 1024ull * 1024 * 1024;
    const auto temporary = std::filesystem::path(target.string() + ".unpacking");
    gzFile in = gzopen(packed.string().c_str(), "rb");
    if (!in) return 0;
    std::uintmax_t written = 0;
    bool whole = false;
    {
        std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
        std::vector<char> buffer(1 << 20);
        while (out) {
            const int read = gzread(in, buffer.data(), static_cast<unsigned>(buffer.size()));
            if (read < 0) break;
            if (read == 0) {
                whole = true;
                break;
            }
            written += static_cast<std::uintmax_t>(read);
            if (written > kLimit) break;
            out.write(buffer.data(), read);
        }
        whole = whole && static_cast<bool>(out);
    }
    gzclose(in);
    std::error_code ec;
    if (!whole) {
        std::filesystem::remove(temporary, ec);
        return 0;
    }
    std::filesystem::rename(temporary, target, ec);
    if (ec) {
        std::filesystem::remove(temporary, ec);
        return 0;
    }
    return written;
}

// Read the sidecar the downloader updates as bytes arrive.
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

// How long a download may go without a single new byte before it is abandoned.
int stall_limit_s() {
    if (const char* override = std::getenv("DSTNS_MAP_STALL_S"); override && *override) {
        const int seconds = std::atoi(override);
        if (seconds > 0) return seconds;
    }
    return 200;
}

// A private process group lets session termination stop the downloader and its
// descendants without touching the launcher's terminal or unrelated processes.
std::mutex child_mutex;
// Every downloader running: the world being prepared, and Dynamic Fastboot's next city in the background.
std::set<pid_t> download_pids;
bool download_cancelled = false;
// `watched` is the file whose progress sidecar shows the download moving. Mirrors
// failing over are not progress: only bytes arriving are, then parsing them.
int run_capture(const std::string& command, std::string& output, const std::string& watched, bool& stalled) {
    output.clear();
    stalled = false;
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
        if (!error) download_pids.insert(pid);
    }
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attr);
    ::close(pipefd[1]);
    if (error) { ::close(pipefd[0]); return -1; }
    std::array<char, 4096> buffer{};
    const auto limit = std::chrono::seconds(stall_limit_s());
    auto last_progress = std::chrono::steady_clock::now();
    MapFetchStatus seen;
    seen.file = watched;
    std::uintmax_t last_bytes = 0;
    std::string last_phase;
    for (;;) {
        pollfd ready{pipefd[0], POLLIN, 0};
        const int polled = ::poll(&ready, 1, 1000);
        if (polled > 0) {
            const auto n = ::read(pipefd[0], buffer.data(), buffer.size());
            if (n > 0) {
                output.append(buffer.data(), static_cast<std::size_t>(n));
                if (output.size() > 65536) output.erase(0, output.size() - 65536);
            } else if (!(n < 0 && errno == EINTR)) break;
        } else if (polled < 0 && errno != EINTR) break;
        read_progress(seen);
        if ((seen.phase == "download" || seen.phase == "parse") && (seen.bytes != last_bytes || seen.phase != last_phase)) {
            last_bytes = seen.bytes;
            last_phase = seen.phase;
            last_progress = std::chrono::steady_clock::now();
        }
        if (std::chrono::steady_clock::now() - last_progress >= limit) {
            stalled = true;
            std::lock_guard lock(child_mutex);
            ::kill(-pid, SIGKILL);
            break;
        }
    }
    ::close(pipefd[0]);
    int status = 0;
    for (;;) {
        {
            std::lock_guard lock(child_mutex);
            const auto reaped = ::waitpid(pid, &status, WNOHANG);
            if (reaped == pid || (reaped < 0 && errno != EINTR)) {
                download_pids.erase(pid);
                return reaped == pid && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

// Keep only the last few lines: Overpass errors are terse, and anything else need not be repeated in full.
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

} // namespace

void cancel_map_download() {
    std::lock_guard lock(child_mutex);
    download_cancelled = true;
    for (const pid_t pid : download_pids) {
        ::kill(-pid, SIGTERM);
        ::kill(-pid, SIGKILL);
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

std::filesystem::path find_fetcher() {
    std::error_code ec;
    if (const char* override = std::getenv("DSTNS_FETCHER"); override && *override) return override;
    std::filesystem::path self;
#if defined(__APPLE__)
    char buffer[4096];
    std::uint32_t size = sizeof buffer;
    if (_NSGetExecutablePath(buffer, &size) == 0) self = std::filesystem::weakly_canonical(buffer, ec);
#else
    self = std::filesystem::read_symlink("/proc/self/exe", ec);
#endif
    if (self.empty()) return {};
    // The server downloads with itself. Another program built on the core, such as the tests, uses the server beside it.
    if (self.filename() == "dstns_server") return self;
    const auto beside = self.parent_path() / "dstns_server";
    return std::filesystem::is_regular_file(beside, ec) ? beside : std::filesystem::path{};
}

// One city's file, downloaded once even when two ask for it: a world wanting the city Dynamic Fastboot is fetching
// waits for that download rather than starting another.
static std::shared_ptr<std::mutex> lock_for(const std::filesystem::path& target) {
    static std::mutex guard;
    static std::map<std::string, std::weak_ptr<std::mutex>> locks;
    std::lock_guard lock(guard);
    auto& slot = locks[target.string()];
    auto held = slot.lock();
    if (!held) slot = held = std::make_shared<std::mutex>();
    return held;
}

MapTileResult acquire_map_tile(const MapLocation& location, const std::filesystem::path& cache_directory, bool background) {
    const auto target = location.cache_path(cache_directory);
    std::error_code ec;
    const auto cached = [&]() -> std::optional<MapTileResult> {
        if (!std::filesystem::is_regular_file(target, ec)) return std::nullopt;
        const auto size = std::filesystem::file_size(target, ec);
        if (!ec && size >= kMinimumTileBytes) return MapTileResult{target, false, size};
        // A truncated cache entry is worse than none; drop it and re-download.
        std::filesystem::remove(target, ec);
        return std::nullopt;
    };

    // Cache hit: the seed names this exact tile and it is already on disk.
    if (auto hit = cached()) return *hit;

    // What the operator sees: published before waiting, so that a download already under way in the background shows
    // its progress here too, read from the same file. A background download publishes nothing.
    std::optional<std::chrono::steady_clock::time_point> published;
    if (!background) {
        std::lock_guard lock(g_fetch_mutex);
        g_fetch = {true, location.city, location.country, "connect", target.string(), 0, 0, 0};
        g_started = std::chrono::steady_clock::now();
        published = g_started;
    }
    // Always clear the published status, however this call leaves.
    struct FetchGuard {
        bool active;
        ~FetchGuard() {
            if (!active) return;
            std::lock_guard lock(g_fetch_mutex);
            g_fetch = {};
        }
    } guard{published.has_value()};
    const auto file_lock = lock_for(target);
    std::unique_lock held(*file_lock, std::defer_lock);
    // In the background, a city someone else is already fetching is theirs to fetch.
    if (!background) held.lock();
    else if (!held.try_lock()) return {target, false, 0};
    if (auto hit = cached()) return *hit;

    std::filesystem::create_directories(cache_directory, ec);
    // Fast Boot: every city was downloaded in advance and kept compressed. Unpacking one takes a moment, and needs no
    // network at all. A damaged one is left alone, and the map is downloaded as usual.
    if (const char* fast = std::getenv("DSTNS_FASTBOOT_DIR"); !ec && fast && *fast) {
        const auto packed = std::filesystem::path(fast) / (location.cache_key() + ".osm.xml.gz");
        if (std::filesystem::is_regular_file(packed, ec)) {
            if (const auto bytes = unpack(packed, target); bytes >= kMinimumTileBytes) return {target, false, bytes};
        }
        ec.clear();
    }
    if (ec) {
        throw MapFetchError("Cannot create map cache directory " + sanitize_message(cache_directory.string()) + ": " + sanitize_message(ec.message()));
    }

    const auto fetcher = find_fetcher();
    if (fetcher.empty()) {
        throw MapFetchError("The map downloader (dstns_server --fetch-osm) was not found; cannot download the map tile for "
                            + location.city + " (" + location.bbox() + ")");
    }

    std::ostringstream command;
    command << shell_quote(fetcher.string()) << " --fetch-osm"
            // "--bbox=VALUE", not "--bbox VALUE": a southern-hemisphere box
            // starts with a minus sign, which would read as an option.
            << " --bbox=" << shell_quote(location.bbox())
            << " --output=" << shell_quote(target.string());

    std::string output;
    bool stalled = false;
    const int status = run_capture(command.str(), output, target.string(), stalled);
    if (stalled) output = "No data arrived for " + std::to_string(stall_limit_s()) + " seconds, so the download was stopped.";
    if (status != 0) {
        std::filesystem::remove(target, ec);
        std::filesystem::remove(target.string() + ".progress", ec);
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
    // Dynamic Fastboot's next city is kept whatever the policy: it is what the next start will use.
    std::string next;
    try {
        std::ifstream pointer(directory / "next-world.json");
        if (pointer) next = nlohmann::json::parse(pointer).value("key", "") + ".osm.xml";
    } catch (const std::exception&) {
    }
    std::erase_if(entries, [&](const Entry& entry) { return !next.empty() && entry.file.filename() == next; });

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
