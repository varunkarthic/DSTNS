// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "support.hpp"

#include "dstns/utf8.hpp"

#include <charconv>
#include <cmath>
#include <cstdlib>
#include <regex>

namespace dstns::fabric {
void send(httplib::Response& r, const json& j, int status) {
    auto copy = j;
    if (copy.is_object() && !copy.contains("ok")) {
        copy["ok"] = (status >= 200 && status < 300);
    }
    r.status = status;
    // JSON is UTF-8 by definition; the exact media type enables httplib compression.
    r.set_content(dump_json(copy), "application/json");
}

std::size_t page_parameter(const httplib::Request& request, const char* key,
                           std::size_t fallback, std::size_t ceiling) {
    if (!request.has_param(key)) return fallback;
    const auto value=request.get_param_value(key);
    std::size_t parsed=0;
    const auto [end,error]=std::from_chars(value.data(),value.data()+value.size(),parsed);
    if(value.empty()||error!=std::errc{}||end!=value.data()+value.size()||(std::string_view(key)=="limit"&&parsed==0))
        throw std::invalid_argument(std::string(key)+" must be a non-negative integer (limit must be positive)");
    return std::min(parsed,ceiling);
}

// The run's seed as the operator wrote it.
//
// The seed is a number: a decimal integer is the form the CLI and the
// interface show, and "0x..." remains accepted for the internal hexadecimal
// form. Absent, empty, "auto" or "random" draws a fresh 64-bit seed, which
// stays short enough to read back and retype.
Seed128 seed_from(const nlohmann::json& j) {
    if (!j.contains("seed") || j.at("seed").is_null()) return Seed128::secure64();
    if (j.at("seed").is_number_unsigned()) {
        const auto value = j.at("seed").get<std::uint64_t>();
        return value == 0 ? Seed128::secure64() : Seed128{0, value};
    }
    if (!j.at("seed").is_string()) return Seed128::secure64();
    const auto text = j.at("seed").get<std::string>();
    if (text.empty() || text == "auto" || text == "random" || text == "0x0") return Seed128::secure64();
    if (text.starts_with("0x") || text.starts_with("0X")) return Seed128::parse(text);
    if (text.find_first_not_of("0123456789") == std::string::npos) return Seed128::from_decimal(text);
    return Seed128::parse(text);
}

// Whether a browser Origin ("scheme://host[:port]") names the host the request
// was addressed to. Ports are compared too, so another local dev server is a
// different origin. A reverse proxy may forward the client's Host in
// X-Forwarded-Host instead. DSTNS_ALLOWED_ORIGINS adds trusted origins,
// comma-separated, for deployments that serve the observer elsewhere.
bool same_origin(const std::string& origin, const std::string& host, const std::string& forwarded_host) {
    if (origin == "null" || origin.empty()) return false;
    if (const char* allowed = std::getenv("DSTNS_ALLOWED_ORIGINS")) {
        std::string list = allowed;
        std::size_t start = 0;
        while (start <= list.size()) {
            const auto comma = list.find(',', start);
            auto item = list.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
            item.erase(0, item.find_first_not_of(' '));
            item.erase(item.find_last_not_of(' ') + 1);
            if (!item.empty() && item == origin) return true;
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
    }
    const auto scheme = origin.find("://");
    if (scheme == std::string::npos) return false;
    const auto authority = origin.substr(scheme + 3);
    auto matches = [&](std::string candidate) {
        // X-Forwarded-Host may carry a list; the first entry is the client's.
        candidate = candidate.substr(0, candidate.find(','));
        candidate.erase(0, candidate.find_first_not_of(' '));
        candidate.erase(candidate.find_last_not_of(' ') + 1);
        return !candidate.empty() && candidate == authority;
    };
    return matches(host) || matches(forwarded_host);
}

// Whether a Host header names this machine rather than some other site. Used
// when the server is bound to loopback, where the only way a hostile web page
// can reach it is DNS rebinding: the page's hostname is re-pointed at 127.0.0.1,
// the browser then treats requests as same-origin, and the Origin-equals-Host
// check passes because both name the attacker. A rebound request still carries
// the attacker's hostname in Host, which this refuses. IP literals and
// localhost names cannot be rebound; DSTNS_ALLOWED_HOSTS (comma-separated)
// admits further names, e.g. a local alias.
bool host_allowed(std::string host) {
    // Strip a port: "[::1]:8090" and "127.0.0.1:8090" alike.
    if (!host.empty() && host.front() == '[') {
        const auto close = host.find(']');
        if (close == std::string::npos) return false;
        return true;  // an IPv6 literal
    }
    if (const auto colon = host.rfind(':'); colon != std::string::npos) host.erase(colon);
    for (auto& c : host) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (host.empty()) return true;  // HTTP/1.0 without Host; not a browser
    if (host == "localhost" || host.ends_with(".localhost")) return true;
    if (host.find_first_not_of("0123456789.") == std::string::npos) return true;  // IPv4 literal
    if (const char* allowed = std::getenv("DSTNS_ALLOWED_HOSTS")) {
        std::string list = allowed;
        std::size_t start = 0;
        while (start <= list.size()) {
            const auto comma = list.find(',', start);
            auto item = list.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
            item.erase(0, item.find_first_not_of(' '));
            item.erase(item.find_last_not_of(' ') + 1);
            for (auto& c : item) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (!item.empty() && item == host) return true;
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
    }
    return false;
}

json body(const httplib::Request& r) {
    if (r.body.empty()) return json::object();
    return json::parse(r.body);
}

// A numeric path segment as a 32-bit ID. std::stoul followed by a narrowing
// cast would quietly turn 4294967297 into 1 and act on the wrong object.
std::uint32_t path_id(const std::string& text) {
    std::uint32_t parsed = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (text.empty() || error != std::errc{} || end != text.data() + text.size())
        throw std::invalid_argument("identifier out of range: " + text);
    return parsed;
}

// An unsigned query parameter; a leading '-' is rejected rather than wrapped.
std::uint64_t unsigned_parameter(const httplib::Request& request, const char* key, std::uint64_t fallback) {
    if (!request.has_param(key)) return fallback;
    const auto value = request.get_param_value(key);
    std::uint64_t parsed = 0;
    const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (value.empty() || error != std::errc{} || end != value.data() + value.size())
        throw std::invalid_argument(std::string(key) + " must be a non-negative integer");
    return parsed;
}

std::uint32_t time_value(const json& v) {
    if (v.is_number_unsigned()) {
        const auto val = v.get<std::uint64_t>();
        if (val > 86400) throw std::invalid_argument("seconds must be in [0, 86400]");
        return static_cast<std::uint32_t>(val);
    }
    if (v.is_number_integer()) {
        const auto val = v.get<std::int64_t>();
        if (val < 0 || val > 86400) throw std::invalid_argument("seconds must be in [0, 86400]");
        return static_cast<std::uint32_t>(val);
    }
    const auto s = v.get<std::string>();
    std::smatch m;
    if (!std::regex_match(s, m, std::regex("([0-2][0-9]):([0-5][0-9]):([0-5][0-9])"))) {
        throw std::invalid_argument("time must be HH:MM:SS");
    }
    const auto h = std::stoi(m[1]), min = std::stoi(m[2]), sec = std::stoi(m[3]);
    if (h > 23) throw std::invalid_argument("hour must be <= 23");
    return static_cast<std::uint32_t>(h * 3600 + min * 60 + sec);
}

ScenarioConfig config_from(const json& j) {
    ScenarioConfig c;
    if (j.contains("playback_duration_seconds")) c.playback_duration_s = j.at("playback_duration_seconds");
    if (j.contains("simulation_time")) c.playback_duration_s = j.at("simulation_time");
    if (j.contains("tick_rate")) c.tick_rate = j.at("tick_rate");
    if (!(c.tick_rate > 0 && c.tick_rate <= kMaxTickRate))
        throw std::invalid_argument("tick_rate must be in (0,5]");
    if (j.contains("day")) {
        if (j.at("day").is_string() && j.at("day") == "auto") c.day = -1;
        else c.day = j.at("day");
    }
    c.saved_seed_id=j.value("saved_seed_id",std::string{});
    c.map_selection_version=j.value("map_selection_version",std::string("urban-crfg-v3"));
    if(c.map_selection_version!="urban-crfg-v3")throw std::invalid_argument("unsupported map selection version");
    if(!c.saved_seed_id.empty()&&!std::regex_match(c.saved_seed_id,std::regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")))throw std::invalid_argument("invalid saved seed ID");
    if (j.contains("modules")) {
        auto& m = j.at("modules");
        c.traffic = m.value("traffic", m.value("traffic_demand", c.traffic));
        c.signals = m.value("signals", m.value("traffic_signals", c.signals));
        c.buildings = m.value("buildings", c.buildings);
        c.dws = m.value("dws", c.dws);
        c.flooding = m.value("flooding", c.flooding);
        c.news = m.value("news", c.news);
    }
    if (j.contains("dws") && j.at("dws").contains("frequency") && j.at("dws").at("frequency").is_number()) {
        c.dws_frequency = j.at("dws").at("frequency");
    }
    if (j.contains("map")) {
        const auto& m = j.at("map");
        c.max_nodes = m.value("max_nodes", c.max_nodes);
        c.osm_file = m.value("osm_file", std::string{});
        c.map_city_extent_m = m.value("city_extent_m", c.map_city_extent_m);
        c.map_district_nodes = m.value("district_nodes", c.map_district_nodes);
        c.map_cache_dir = m.value("cache_dir", c.map_cache_dir);
        if (!(c.map_city_extent_m >= 500 && c.map_city_extent_m <= 20000))
            throw std::invalid_argument("map.city_extent_m must be in [500, 20000] metres");
        if (c.map_district_nodes < 200 || c.map_district_nodes > 50000)
            throw std::invalid_argument("map.district_nodes must be in [200, 50000]");
    }
    if (j.contains("fixture")) {
        auto& f = j.at("fixture");
        c.grid_width = f.value("grid_width", c.grid_width);
        c.grid_height = f.value("grid_height", c.grid_height);
    } else if (c.osm_file.empty()) {
        c.osm_file = "auto";
    }
    return c;
}
} // namespace dstns::fabric
