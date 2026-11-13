// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// `dstns_server --fetch-osm`: download one district from Overpass. Existing files are never overwritten.
//
// Two ways to name the area:
//
//     --bbox south,west,north,east          explicit box
//     --anchor lat,lon --radius-m 2500      box centred on a point
//
// The engine runs this in a process of its own, with --bbox, using coordinates its seed derived, and treats a non-zero
// exit as a hard map-generation failure. Its last line of output is the reason, prefixed `fetch_osm:`. Downloads are
// written beside the target and renamed, so an interrupted run cannot leave a truncated map behind, and progress is
// published beside it as `<output>.progress` for the engine and the operator to read.

#include "dstns/osm_fetch.hpp"
#include "dstns/rng.hpp"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

namespace dstns {
namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

// Overpass mirrors, tried in order. One host refusing connections, rate limiting or timing out must not end a run, so
// the fetcher fails over rather than depending on a single volunteer-run server. Override with --endpoint (repeatable)
// or DSTNS_OVERPASS_ENDPOINTS to use a private instance.
const std::vector<std::string> kDefaultEndpoints = {
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
};
// A mirror that will not even accept a connection is not worth a full wait for data.
constexpr long kConnectSeconds = 10;
constexpr std::uintmax_t kMaxBytes = 200ull * 1024 * 1024;
constexpr double kMaxAreaSqDeg = 0.05;
constexpr double kMetresPerDegreeLat = 111320.0;

struct Options {
    std::string bbox, anchor;
    double radius_m = 2500;
    fs::path output = "data/maps/berlin-urban.osm.xml";
    int retries = 1;
    std::vector<std::string> endpoints;
    int timeout = 90;
    double quiet_seconds = 60;
};

fs::path progress_path(const Options& o) { return o.output.string() + ".progress"; }

[[noreturn]] void fail(const Options& o, const std::string& message) {
    std::error_code ec;
    fs::remove(progress_path(o), ec);
    std::cerr << "fetch_osm: " << message << std::endl;
    std::exit(1);
}

// Progress reporting must never break the download, so every failure here is ignored.
void publish(const Options& o, const std::string& phase, std::uintmax_t done = 0, std::uintmax_t total = 0) {
    const auto path = progress_path(o);
    const auto temporary = fs::path(path.string() + ".tmp");
    {
        std::ofstream out(temporary, std::ios::trunc);
        if (!out) return;
        out << json{{"phase", phase}, {"bytes", done}, {"total", total}}.dump();
    }
    std::error_code ec;
    fs::rename(temporary, path, ec);
}

std::optional<double> number(const std::string& text) {
    try {
        std::size_t used = 0;
        const double value = std::stod(text, &used);
        if (used != text.size() || !std::isfinite(value)) return std::nullopt;
        return value;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

std::vector<std::string> split(const std::string& text, char by) {
    std::vector<std::string> parts;
    std::string part;
    std::istringstream in(text);
    while (std::getline(in, part, by)) parts.push_back(part);
    if (!text.empty() && text.back() == by) parts.emplace_back();
    return parts;
}

std::string trim(std::string text) {
    const auto first = text.find_first_not_of(" \t");
    if (first == std::string::npos) return {};
    return text.substr(first, text.find_last_not_of(" \t") - first + 1);
}

std::array<double, 4> coordinates(const Options& o) {
    if (!o.bbox.empty() && !o.anchor.empty()) fail(o, "provide either --bbox or --anchor, not both");
    if (!o.bbox.empty()) {
        const auto parts = split(o.bbox, ',');
        std::array<double, 4> values{};
        if (parts.size() != 4) fail(o, "--bbox must be four comma-separated numbers: south,west,north,east");
        for (std::size_t i = 0; i < 4; ++i) {
            const auto value = number(trim(parts[i]));
            if (!value) fail(o, "--bbox must be four comma-separated numbers: south,west,north,east");
            values[i] = *value;
        }
        return values;
    }
    if (o.anchor.empty()) fail(o, "provide --bbox or --anchor");
    const auto parts = split(o.anchor, ',');
    const auto lat = parts.size() == 2 ? number(trim(parts[0])) : std::nullopt;
    const auto lon = parts.size() == 2 ? number(trim(parts[1])) : std::nullopt;
    if (!lat || !lon) fail(o, "--anchor must be \"lat,lon\"");
    if (!(o.radius_m > 0)) fail(o, "--radius-m must be positive");
    const double d_lat = o.radius_m / kMetresPerDegreeLat;
    const double d_lon = o.radius_m / (kMetresPerDegreeLat * std::max(0.01, std::cos(*lat * M_PI / 180)));
    return {*lat - d_lat, *lon - d_lon, *lat + d_lat, *lon + d_lon};
}

// The shortest decimal that reads back as the same number, as Python's str() writes floats in the query.
std::string decimal(double value) {
    char buffer[32];
    for (int digits = 1; digits <= 17; ++digits) {
        std::snprintf(buffer, sizeof buffer, "%.*g", digits, value);
        if (std::strtod(buffer, nullptr) == value) break;
    }
    std::string text = buffer;
    if (text.find_first_of(".e") == std::string::npos) text += ".0";
    return text;
}

std::string host_of(const std::string& url) {
    const auto scheme = url.find("://");
    const auto start = scheme == std::string::npos ? 0 : scheme + 3;
    const auto end = url.find('/', start);
    return url.substr(start, end == std::string::npos ? std::string::npos : end - start);
}

struct Transfer {
    const Options* options;
    std::ofstream* out;
    std::uintmax_t size = 0;
    bool too_large = false;
    std::chrono::steady_clock::time_point last_publish{};
};

std::size_t on_data(char* data, std::size_t size, std::size_t count, void* user) {
    auto& t = *static_cast<Transfer*>(user);
    const auto n = size * count;
    t.size += n;
    if (t.size > kMaxBytes) {
        t.too_large = true;
        return 0;
    }
    t.out->write(data, static_cast<std::streamsize>(n));
    return *t.out ? n : 0;
}

int on_progress(void* user, curl_off_t total, curl_off_t received, curl_off_t, curl_off_t) {
    auto& t = *static_cast<Transfer*>(user);
    const auto now = std::chrono::steady_clock::now();
    if (received > 0 && now - t.last_publish > std::chrono::milliseconds(250)) {
        publish(*t.options, "download", static_cast<std::uintmax_t>(received), static_cast<std::uintmax_t>(total));
        t.last_publish = now;
    }
    return 0;
}

// Whether this is a map with roads in it. Read once, as the engine reads it, rather than parsed in full: the engine's
// own loader is what parses it, and what's asked here is only whether a mirror sent a map, an error or nothing.
// Returns an empty string for a map with roads, "empty" for one without, or why it can't be used.
std::string check_map(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    std::string text((std::istreambuf_iterator<char>(in)), {});
    std::size_t at = 0;
    // The root: past the declaration, comments and whitespace.
    for (;;) {
        at = text.find('<', at);
        if (at == std::string::npos) return "Overpass returned unparseable XML: no element found";
        if (text.compare(at, 2, "<?") == 0) at = text.find("?>", at);
        else if (text.compare(at, 4, "<!--") == 0) at = text.find("-->", at);
        else break;
        if (at == std::string::npos) return "Overpass returned unparseable XML: unclosed declaration";
    }
    const auto name_end = text.find_first_of(" \t\r\n/>", at + 1);
    const auto root = text.substr(at + 1, name_end == std::string::npos ? std::string::npos : name_end - at - 1);
    if (root != "osm") return "expected an <osm> document, got <" + root + ">";
    if (const auto remark = text.find("<remark>"); remark != std::string::npos) {
        const auto end = text.find("</remark>", remark);
        auto what = trim(text.substr(remark + 8, end == std::string::npos ? 200 : end - remark - 8));
        for (auto& c : what) if (c == '\n' || c == '\r') c = ' ';
        return "Overpass reported an error: " + (what.empty() ? std::string("unspecified") : what);
    }
    const bool closed = text.find("</osm>") != std::string::npos || text.find("/>", name_end) == text.find('>', name_end) - 1;
    if (!closed) return "Overpass returned unparseable XML: the document ends early";
    return text.find("<way ") != std::string::npos || text.find("<way>") != std::string::npos ? "" : "empty";
}

std::string iso_now() {
    const auto now = std::time(nullptr);
    std::tm utc{};
    gmtime_r(&now, &utc);
    char buffer[40];
    std::strftime(buffer, sizeof buffer, "%Y-%m-%dT%H:%M:%S+00:00", &utc);
    return buffer;
}

int run(const Options& o) {
    const auto [south, west, north, east] = coordinates(o);
    char range[160];
    std::snprintf(range, sizeof range, "%s,%s,%s,%s", decimal(south).c_str(), decimal(west).c_str(), decimal(north).c_str(), decimal(east).c_str());
    if (!(-90 <= south && south < north && north <= 90 && -180 <= west && west < east && east <= 180))
        fail(o, std::string("bbox out of range or inverted: ") + range);
    const double area = (north - south) * (east - west);
    if (area > kMaxAreaSqDeg) {
        char message[200];
        std::snprintf(message, sizeof message, "requested area %.4f sq deg exceeds the %s sq deg limit; reduce --radius-m", area, decimal(kMaxAreaSqDeg).c_str());
        fail(o, message);
    }
    std::error_code ec;
    if (fs::exists(o.output, ec)) fail(o, o.output.string() + " already exists; delete it or choose another path to preserve reproducibility");

    const std::string box = range;
    std::string query = "[out:xml][timeout:" + std::to_string(o.timeout) + "];(";
    for (const char* key : {"highway", "building", "landuse", "leisure"}) query += std::string("way[\"") + key + "\"](" + box + ");";
    for (const char* key : {"amenity", "shop", "office"}) query += std::string("nwr[\"") + key + "\"](" + box + ");";
    query += "node[\"highway\"=\"traffic_signals\"](" + box + "););(._;>;);out body;";

    std::vector<std::string> endpoints = o.endpoints;
    if (endpoints.empty())
        if (const char* listed = std::getenv("DSTNS_OVERPASS_ENDPOINTS"))
            for (const auto& part : split(listed, ','))
                if (const auto e = trim(part); !e.empty()) endpoints.push_back(e);
    if (endpoints.empty()) endpoints = kDefaultEndpoints;

    fs::create_directories(o.output.parent_path().empty() ? fs::path(".") : o.output.parent_path(), ec);
    const fs::path temporary = o.output.string() + "." + std::to_string(::getpid()) + ".part";

    curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL* curl = curl_easy_init();
    char* escaped = curl_easy_escape(curl, query.c_str(), static_cast<int>(query.size()));
    const std::string payload = std::string("data=") + escaped;
    curl_free(escaped);

    std::string used_endpoint;
    std::uintmax_t size = 0;
    bool done = false;
    // Per-endpoint outcome, so a failure can say what every mirror actually said rather than only the last one.
    std::vector<std::string> order;
    std::map<std::string, std::string> outcomes;
    bool refused_everywhere = true;
    publish(o, "connect");
    auto remaining = endpoints;
    for (int attempt = 0; attempt <= o.retries && !done; ++attempt) {
        // A busy mirror is left for the next one at once. Only when all have been tried is it worth asking again.
        if (attempt) {
            publish(o, "retry");
            std::this_thread::sleep_for(std::chrono::seconds(3 << (attempt - 1)));
        }
        std::vector<std::string> retry;
        for (const auto& endpoint : remaining) {
            std::string reason;
            Transfer transfer{&o, nullptr};
            long status = 0;
            CURLcode code;
            {
                std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
                transfer.out = &out;
                curl_easy_reset(curl);
                curl_easy_setopt(curl, CURLOPT_URL, endpoint.c_str());
                curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
                curl_easy_setopt(curl, CURLOPT_USERAGENT, "DSTNS urban source importer");
                // Asks for gzip, and stores the map itself.
                curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "gzip");
                curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, kConnectSeconds);
                // Moves on from a mirror that has sent nothing for this long.
                curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
                curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, std::max(1L, std::lround(o.quiet_seconds)));
                curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 0L);
                curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_data);
                curl_easy_setopt(curl, CURLOPT_WRITEDATA, &transfer);
                curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, on_progress);
                curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &transfer);
                curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
                curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
                // A quiet mirror below a second is still quiet: low-speed time is whole seconds, so a fraction is
                // held to with an overall limit on a mirror that has sent nothing at all.
                if (o.quiet_seconds < 1) curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, std::max(100L, std::lround(o.quiet_seconds * 1000) + 1000));
                code = curl_easy_perform(curl);
                curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
            }
            if (transfer.too_large) {
                fs::remove(temporary, ec);
                fail(o, "OSM response exceeds " + std::to_string(kMaxBytes / (1024 * 1024)) + " MiB; reduce the extent");
            }
            if (code == CURLE_OK && status >= 400) {
                // 429 and 5xx are Overpass shedding load; anything else is our request.
                reason = "HTTP " + std::to_string(status);
                refused_everywhere = false;
                if (status == 429 || (status >= 500 && status <= 504)) retry.push_back(endpoint);
            } else if (code != CURLE_OK) {
                reason = curl_easy_strerror(code);
                if (code != CURLE_COULDNT_CONNECT && code != CURLE_COULDNT_RESOLVE_HOST) refused_everywhere = false;
                retry.push_back(endpoint);
            } else {
                publish(o, "parse", transfer.size, transfer.size);
                const auto problem = check_map(temporary);
                if (problem == "empty") {
                    fs::remove(temporary, ec);
                    fail(o, "no roads found in " + box + "; the tile is empty water or wilderness");
                }
                if (problem.empty()) {
                    used_endpoint = endpoint;
                    size = transfer.size;
                    done = true;
                    break;
                }
                reason = problem;
                refused_everywhere = false;
                retry.push_back(endpoint);
            }
            fs::remove(temporary, ec);
            if (!outcomes.count(endpoint)) order.push_back(endpoint);
            outcomes[endpoint] = host_of(endpoint) + " (" + (reason.empty() ? "no response" : reason) + ")";
            publish(o, "connect");
        }
        if (retry.empty()) break;
        remaining = retry;
    }
    curl_easy_cleanup(curl);
    curl_global_cleanup();

    if (!done) {
        std::string detail;
        for (const auto& endpoint : order) detail += (detail.empty() ? "" : "; ") + outcomes[endpoint];
        if (detail.empty()) detail = "no endpoints configured";
        if (refused_everywhere)
            fail(o, "no route to Overpass from this host: " + detail + ". Check the network connection, VPN or proxy, or set DSTNS_OVERPASS_ENDPOINTS "
                    "to a reachable Overpass instance. An already cached city can be used with --osm-file.");
        fail(o, "every Overpass endpoint failed: " + detail);
    }

    // ponytail: hashed in one read, which holds the map in memory twice; it runs in a process of its own, so only that
    // process ever holds it. An incremental SHA-256 would avoid it if maps grow toward the 200 MiB limit.
    std::ifstream in(temporary, std::ios::binary);
    const std::string body((std::istreambuf_iterator<char>(in)), {});
    in.close();
    const auto digest = sha256(body);
    // Renamed into place, so readers never observe a partial file.
    fs::rename(temporary, o.output, ec);
    if (ec) {
        fs::remove(temporary, ec);
        fail(o, "could not write " + o.output.string() + ": " + ec.message());
    }
    const json manifest = {
        {"source", "OpenStreetMap contributors"},
        {"license", "ODbL 1.0"},
        {"url", "https://www.openstreetmap.org/copyright"},
        {"endpoint", used_endpoint},
        {"bbox", {south, west, north, east}},
        {"retrieved_at", iso_now()},
        {"sha256", digest},
        {"bytes", size},
        {"query", query},
    };
    auto manifest_path = o.output;
    manifest_path.replace_extension(".manifest.json");
    std::ofstream(manifest_path) << manifest.dump(2) << "\n";
    fs::remove(progress_path(o), ec);
    std::cout << manifest.dump(2) << std::endl;
    return 0;
}

} // namespace

int fetch_osm_main(int argc, char** argv) {
    Options o;
    const auto value = [&](int& i, const std::string& arg, const std::string& name) -> std::optional<std::string> {
        if (arg.rfind(name + "=", 0) == 0) return arg.substr(name.size() + 1);
        if (arg == name) {
            if (i + 1 >= argc) fail(o, name + " needs a value");
            return std::string(argv[++i]);
        }
        return std::nullopt;
    };
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--fetch-osm") continue;
        if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: dstns_server --fetch-osm (--bbox=S,W,N,E | --anchor=LAT,LON [--radius-m=M]) [--output=FILE]\n"
                         "                    [--retries=N] [--endpoint=URL ...] [--timeout=S] [--quiet-seconds=S]\n";
            return 0;
        }
        if (auto v = value(i, arg, "--bbox")) o.bbox = *v;
        else if (auto v2 = value(i, arg, "--anchor")) o.anchor = *v2;
        else if (auto v3 = value(i, arg, "--output")) o.output = *v3;
        else if (auto v4 = value(i, arg, "--endpoint")) o.endpoints.push_back(*v4);
        else if (auto v5 = value(i, arg, "--radius-m")) o.radius_m = number(*v5).value_or(NAN);
        else if (auto v6 = value(i, arg, "--retries")) o.retries = std::max(0, std::atoi(v6->c_str()));
        else if (auto v7 = value(i, arg, "--timeout")) o.timeout = std::max(1, std::atoi(v7->c_str()));
        else if (auto v8 = value(i, arg, "--quiet-seconds")) o.quiet_seconds = number(*v8).value_or(60);
        else fail(o, "unknown argument " + arg);
    }
    return run(o);
}

} // namespace dstns
