// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/build_info.hpp"

#include "dstns/utf8.hpp"
#include "dstns/geo.hpp"
#include "dstns/osm_fetch.hpp"
#include "dstns/sumo_bridge.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <charconv>
#include <cstdlib>
#include <cmath>
#include <fstream>
#include <regex>
#include <thread>

namespace dstns {
namespace {
using json = nlohmann::json;

void send(httplib::Response& r, const json& j, int status = 200) {
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
} // namespace

ApiServer::ApiServer(SimulationEngine& e, RuntimeLogger& l)
    : engine_(e), logger_(l), server_(std::make_unique<httplib::Server>()) {
    routes();
}

ApiServer::~ApiServer() {
    stop();
    if (shutdown_worker_.joinable()) shutdown_worker_.join();
}

void ApiServer::routes() {
    auto find_dist = []() -> std::filesystem::path {
        for (const auto& dir : {
            "ui-engine/dist",
            "../ui-engine/dist",
            "../../ui-engine/dist",
            "dist",
            "/app/ui-engine/dist"
        }) {
            if (std::filesystem::exists(dir)) return std::filesystem::absolute(dir);
        }
        return {};
    };

    const auto dist = find_dist();
    if(std::filesystem::exists("media"))server_->set_mount_point("/media",std::filesystem::absolute("media").string());
    server_->Get("/media/logo.png",[](const auto&,auto& r){r.status=404;});
    const std::string operator_token=std::getenv("DSTNS_OPERATOR_TOKEN")?std::getenv("DSTNS_OPERATOR_TOKEN"):"";
    const auto loopback_only=loopback_only_;
    server_->set_pre_routing_handler([operator_token,loopback_only](const auto& req,auto& r){
        // DNS rebinding: see host_allowed. Applies to reads as well as writes,
        // since a rebound page could otherwise read the whole run.
        if (loopback_only->load() && !host_allowed(req.get_header_value("Host"))) {
            send(r,{{"error",{{"code","HOST_NOT_ALLOWED"},{"message","This server is bound to loopback and answers only to localhost or an IP address. Set DSTNS_ALLOWED_HOSTS to admit another name."}}}},421);
            return httplib::Server::HandlerResponse::Handled;
        }
        // A browser names the page that sent a request in Origin. A state-
        // changing request from a page served by some other host is a cross-
        // site request forgery, not the observer, and is refused. Clients that
        // are not browsers (the CLI, scripts) send no Origin and are unaffected.
        if (req.method != "GET" && req.method != "HEAD" && req.method != "OPTIONS" && req.has_header("Origin")
            && !same_origin(req.get_header_value("Origin"), req.get_header_value("Host"), req.get_header_value("X-Forwarded-Host"))) {
            send(r,{{"error",{{"code","CROSS_ORIGIN_FORBIDDEN"},{"message","State-changing requests must come from the observer's own origin."}}}},403);
            return httplib::Server::HandlerResponse::Handled;
        }
        if((req.path=="/api/v1/playback/start"||req.path=="/api/v1/playback/prepare") && req.method=="POST" && (operator_token.empty()||req.get_header_value("X-DSTNS-Operator")!=operator_token)) {
            send(r,{{"error",{{"code","CLI_START_REQUIRED"},{"message","Start simulations through the operator CLI."}}}},403);return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });
    if (!dist.empty() && std::filesystem::exists(dist / "assets")) {
        server_->set_mount_point("/assets", (dist / "assets").string());
    }

    auto index_handler = [this, dist](const httplib::Request&, httplib::Response& r) {
        observer_loads_.fetch_add(1);
        if (!dist.empty() && std::filesystem::exists(dist / "index.html")) {
            std::ifstream f(dist / "index.html");
            if (f) {
                std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                r.set_content(content, "text/html; charset=utf-8");
                return;
            }
        }
        r.set_content("<!DOCTYPE html><html><head><title>DSTNS</title></head><body><h1>DSTNS Engine</h1><p>API Server active on port 8090.</p></body></html>", "text/html; charset=utf-8");
    };
    // The browser icon lives beside index.html rather than under /assets,
    // because the page references it by a fixed path.
    // Whether the observer has been loaded in a browser yet. The launcher
    // opens the interface first and waits for this before starting a run, so
    // world selection and the download are watched rather than hidden.
    server_->Get("/api/v1/system/observer", [this](const auto&, auto& r) {
        const auto loads = observer_loads_.load();
        send(r, {{"api_version", "1.0"}, {"data", {{"loaded", loads > 0}, {"loads", loads}}}});
    });
    server_->Get("/favicon.svg", [dist](const httplib::Request&, httplib::Response& r) {
        std::ifstream f(dist / "favicon.svg");
        if (dist.empty() || !f) {
            r.status = 404;
            return;
        }
        std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        r.set_content(content, "image/svg+xml");
    });
    server_->Get("/", index_handler);
    server_->Get("/index.html", index_handler);

    // CORS is granted per request, below, not to everyone: "*" would let any
    // web page the operator visits read the run from a local server.
    server_->set_default_headers({
        {"Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Authorization"},
        {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"},
        {"Cache-Control", "no-store"}
    });

    // Only the server's own origin, and origins listed in DSTNS_ALLOWED_ORIGINS,
    // may read responses from a browser. The observer is served by this server,
    // so it is same-origin and needs no cross-origin grant at all.
    server_->set_post_routing_handler([](const auto& req, auto& res) {
        const auto origin = req.get_header_value("Origin");
        if (!origin.empty() && same_origin(origin, req.get_header_value("Host"), req.get_header_value("X-Forwarded-Host"))) {
            res.set_header("Access-Control-Allow-Origin", origin);
        }
        res.set_header("Vary", "Origin");
    });

    server_->Options(R"(.*)", [](const auto&, auto& r) {
        r.status = 204;
    });

    server_->set_exception_handler([this](const auto& req, auto& res, std::exception_ptr ep) {
        std::string message = "internal server error", code = "INTERNAL_ERROR";
        int status = 500;
        try {
            if (ep) std::rethrow_exception(ep);
        } catch (const MapFetchError& e) {
            // The seed names a real place that could not be downloaded. This is
            // upstream/environmental, and retryable, so it must not look like a
            // bad request or a crash.
            message = e.what();
            code = "MAP_FETCH_FAILED";
            status = 503;
        } catch (const nlohmann::json::parse_error& e) {
            message = std::string("Malformed JSON: ") + e.what();
            code = "INVALID_JSON";
            status = 400;
        } catch (const nlohmann::json::out_of_range& e) {
            message = e.what();
            code = "MISSING_FIELD";
            status = 400;
        } catch (const nlohmann::json::type_error& e) {
            message = e.what();
            code = "INVALID_FIELD_TYPE";
            status = 400;
        } catch (const std::invalid_argument& e) {
            message = e.what();
            code = "INVALID_REQUEST";
            status = 400;
        } catch (const std::out_of_range& e) {
            message = e.what();
            code = "NOT_FOUND";
            status = 404;
        } catch (const std::logic_error& e) {
            message = e.what();
            code = "LIFECYCLE_CONFLICT";
            status = 409;
        } catch (const std::exception& e) {
            message = e.what();
        }
        send(res, {{"ok", false}, {"api_version", "1.0"}, {"error", {{"code", code}, {"message", message}}}}, status);
        logger_.system("ERROR", "api", req.method + " " + req.path + ": " + message);
    });

    server_->set_logger([this](const auto& req, const auto& res) {
        logger_.api(req.method, req.path, res.status, 0);
    });

    // Health & System Status
    auto health_handler = [this](const auto&, auto& r) {
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"observer_ui_version", "observer-v2"},
            {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
            {"version", DSTNS_VERSION},
            {"lifecycle", to_string(engine_.lifecycle())}
        });
    };
    server_->Get("/health", health_handler);
    server_->Get("/api/v1/system/health", health_handler);
    server_->Get("/api/v1/system/status", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Get("/api/v1/system/info", [this](const auto&, auto& r) {
        auto env = SumoBridge::detect();
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
            {"version", DSTNS_VERSION},
            {"build", {{"compiler", __VERSION__}, {"cpp_standard", __cplusplus},
                       {"revision", DSTNS_REVISION}, {"created", DSTNS_BUILD_DATE},
                       {"channel", DSTNS_CHANNEL}, {"type", DSTNS_BUILD_TYPE},
                       {"architecture", DSTNS_BUILD_ARCH}}},
            {"lifecycle", to_string(engine_.lifecycle())},
            {"sumo", {
                {"available", env.available},
                {"version", env.sumo_version},
                {"sumo_binary", env.sumo_binary.string()},
                {"netconvert_binary", env.netconvert_binary.string()},
                {"sumo_home", env.sumo_home.string()}
            }}
        });
    });

    // An index of the API, served by the API. A client that has the base URL
    // can discover everything else from here rather than from a document that
    // may have drifted.
    auto index_of_api = [] {
        auto group = [](const char* name, const char* purpose, std::initializer_list<std::array<const char*,3>> routes) {
            auto items = nlohmann::json::array();
            for (const auto& [method, path, note] : routes)
                items.push_back({{"method",method},{"path",path},{"description",note}});
            return nlohmann::json{{"group",name},{"purpose",purpose},{"endpoints",std::move(items)}};
        };
        return nlohmann::json::array({
            group("system","Service identity, health and lifecycle",{
                {{"GET","/api/v1/system/health","Liveness, with the engine's lifecycle state"}},
                {{"GET","/api/v1/system/info","Service identity, version and SUMO availability"}},
                {{"GET","/api/v1/system/status","The full run status"}},
                {{"GET","/api/v1/system/endpoints","This index"}},
                {{"GET","/api/v1/system/map-status","What map is loaded and where it came from"}},
                {{"GET","/api/v1/system/source","Source offer under AGPL-3.0 section 13"}},
                {{"GET","/api/v1/system/backpressure","Adaptive backpressure score and mode"}},
                {{"POST","/api/v1/system/backpressure","Report observer health"}},
                {{"GET","/api/v1/system/ui-config","Operator defaults for the interface"}},
                {{"GET","/api/v1/system/observer","Observer page-load count"}},
                {{"POST","/api/v1/system/terminate","Stop the simulation and exit the process"}}}),
            group("playback","Moving through simulated time",{
                {{"GET","/api/v1/playback/status","Clock, rate and lifecycle"}},
                {{"POST","/api/v1/playback/start","Begin a run"}},
                {{"POST","/api/v1/playback/prepare","Prepare without starting playback"}},
                {{"POST","/api/v1/playback/play","Resume"}},
                {{"POST","/api/v1/playback/pause","Hold the clock"}},
                {{"POST","/api/v1/playback/stop","End the run"}},
                {{"POST","/api/v1/playback/reset","Return to the start"}},
                {{"POST","/api/v1/playback/seek","Jump to a virtual second"}},
                {{"POST","/api/v1/playback/step","Advance a fixed number of ticks"}}}),
            group("world","The generated world and its topology",{
                {{"GET","/api/v1/view/topology","Nodes, edges, features, projection and bounds"}},
                {{"GET","/api/v1/view/nodes","Paginated nodes; /{id} for one"}},
                {{"GET","/api/v1/view/edges","Paginated edges; /{id} for one"}},
                {{"GET","/api/v1/view/places","Classified places with live demand; ?kind= filters"}},
                {{"GET","/api/v1/view/place-kinds","The place taxonomy and this world's counts"}},
                {{"GET","/api/v1/view/stops","Bus stops, thinned to realistic spacing"}},
                {{"GET","/api/v1/view/snapshot","Per-tick dynamic state for every node and edge"}},
                {{"GET","/api/v1/view/global","Topology and snapshot in one response"}},
                {{"POST","/api/v1/world/regenerate","Build a new world from a seed"}},
                {{"GET","/api/v1/world/status","Preparation progress and durable errors"}}}),
            group("control","Acting on the running simulation",{
                {{"PUT","/api/v1/control/tick-rate","Set the simulation rate multiplier"}},
                {{"POST","/api/v1/control/day","Switch between a weekday and a weekend"}},
                {{"PUT","/api/v1/control/modules/{module}","Enable or disable a subsystem"}},
                {{"POST","/api/v1/control/events/weather","Inject rain or a flood"}},
                {{"POST","/api/v1/control/events/traffic","Inject an incident or a closure"}},
                {{"POST","/api/v1/control/events/surge","Inject a demand surge"}},
                {{"PUT","/api/v1/control/edges/{id}/override","Override one edge"}},
                {{"POST","/api/v1/control/undo","Undo the last control action"}},
                {{"POST","/api/v1/control/redo","Redo it"}},
                {{"GET","/api/v1/control/history","The control history"}}}),
            group("observation","Logs, events and news",{
                {{"GET","/api/v1/view/event-queue","Scheduled or executed events, filtered and paged"}},
                {{"GET","/api/v1/news","The operator news feed"}},
                {{"GET","/api/v1/news/stream","The same feed, as server-sent events"}},
                {{"GET","/api/v1/view/logs/system","System log"}},
                {{"GET","/api/v1/view/logs/events","Event log"}},
                {{"GET","/api/v1/view/logs/api","API access log"}}}),
        });
    };
    server_->Get("/api/v1/system/endpoints", [index_of_api](const auto&, auto& r) {
        send(r, {{"ok",true},{"version","v1"},{"base","/api/v1"},{"groups",index_of_api()}});
    });
    server_->Get("/api/v1", [index_of_api](const auto&, auto& r) {
        send(r, {{"ok",true},{"version","v1"},{"base","/api/v1"},{"groups",index_of_api()}});
    });

    // SUMO Microscopic Export & Simulation
    server_->Post("/api/v1/export/sumo", [this](const auto& req, auto& r) {
        auto j = body(req);
        std::filesystem::path dir = j.value("directory", "data/sumo_export");
        send(r, engine_.export_sumo(dir));
    });
    server_->Post("/api/v1/system/sumo-simulate", [this](const auto& req, auto& r) {
        auto j = body(req);
        std::filesystem::path dir = j.value("directory", "data/sumo_run");
        const auto begin_s = time_value(j.value("begin_s", json(0)));
        const auto end_s = time_value(j.value("end_s", json(3600)));
        send(r, engine_.sumo_simulate(dir, begin_s, end_s));
    });

    auto terminate_handler = [this](const auto&, auto& r) {
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
            {"status", "TERMINATING"},
            {"message", "DSTNS server is shutting down gracefully."}
        });
        // Terminating means quitting: the process goes away, not just the run.
        //
        // The request is made lock-free because a scenario compile can hold the
        // engine lock for the length of a map download, and an operator who has
        // asked to quit should not wait that out. The listener is then stopped
        // so main() can return normally, and a backstop guarantees the process
        // exits even if a long-running compile is still unwinding.
        engine_.request_terminate();
        logger_.system("INFO", "api", "Termination requested; shutting down");
        if (termination_started_.exchange(true)) return;
        shutdown_worker_ = std::thread([this]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(150));
            stop();
        });
        // No captured object: this fallback can outlive ApiServer safely. The
        // owned downloader group was already cancelled before starting it.
        std::thread([] {
            std::this_thread::sleep_for(std::chrono::seconds(3));
            std::fflush(nullptr);
            std::_Exit(0);
        }).detach();
    };
    // POST only: a GET that shuts the server down can be triggered by any
    // page the operator happens to open, through an image or a link.
    server_->Post("/terminate", terminate_handler);
    server_->Post("/api/v1/system/terminate", terminate_handler);

    // AGPL section 13: this program is offered over a network, so every user
    // interacting with it must be told where to obtain the corresponding
    // source of the version they are running.
    server_->Get("/api/v1/system/source", [](const auto&, auto& r) {
        send(r, {{"api_version", "1.0"},
                 {"data", {
                     {"program", "DSTNS"},
                     {"version", DSTNS_VERSION},
                     {"copyright", "Copyright (C) 2026 Varun Karthic"},
                     {"license", "AGPL-3.0-or-later"},
                     {"license_url", "https://www.gnu.org/licenses/agpl-3.0.html"},
                     {"source_offer",
                      "You may obtain the complete corresponding source for this running "
                      "version, under the terms of the GNU Affero General Public License "
                      "version 3 or later. The source accompanies this deployment; see the "
                      "LICENSE and COPYRIGHT files distributed with it."},
                     {"map_data", {
                         {"source", "OpenStreetMap contributors"},
                         {"license", "ODbL 1.0"},
                         {"url", "https://www.openstreetmap.org/copyright"}}}}}});
    });

    // Observability for a download in flight. Unauthenticated and read-only:
    // it reports only progress through a map the seed already determined.
    server_->Get("/api/v1/system/map-status", [this](const auto&, auto& r) {
        const auto status = current_map_fetch();
        send(r, {{"api_version", "1.0"},
                 {"data", {{"active", status.active},
                           // What a preparation is spending its time on, even
                           // while no map is being downloaded.
                           {"preparation", engine_.preparation_stage()},
                           {"city", status.city},
                           {"country", status.country},
                           {"phase", status.phase},
                           {"bytes", status.bytes},
                           {"total", status.total},
                           {"elapsed_s", status.elapsed_s}}}});
    });

    // Presentation defaults for the observer. Served rather than bundled so an
    // operator can change the interface's starting state without rebuilding the
    // front end. Nothing here reaches the simulation.
    server_->Get("/api/v1/system/ui-config", [](const auto&, auto& r) {
        for (const auto* candidate : {"config/ui-config.json", "../config/ui-config.json",
                                      "/app/config/ui-config.json"}) {
            std::ifstream in(candidate);
            if (!in) continue;
            try {
                json parsed;
                in >> parsed;
                send(r, {{"api_version", "1.0"}, {"data", parsed}});
                return;
            } catch (const json::parse_error& e) {
                // A malformed file must not take the interface down; the client
                // falls back to its built-in defaults and the operator is told.
                send(r, {{"api_version", "1.0"},
                         {"error", {{"code", "UI_CONFIG_INVALID"},
                                    {"message", std::string("config/ui-config.json is not valid JSON: ") + e.what()}}}},
                     500);
                return;
            }
        }
        send(r, {{"api_version", "1.0"}, {"data", json::object()}});
    });

    // ASB. The observer reports how far behind it is; the response carries the
    // full backpressure state so one round trip both informs and instructs.
    server_->Post("/api/v1/system/backpressure", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.report_backpressure(
                    j.value("virtual_lag_s", 0.0),
                    j.value("client_frame_s", 0.0),
                    j.value("since_poll_s", 0.0)));
    });
    server_->Get("/api/v1/system/backpressure", [this](const auto&, auto& r) {
        send(r, engine_.backpressure());
    });

    // Playback API
    server_->Get("/api/v1/playback/status", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Post("/api/v1/playback/start", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        const auto start = j.contains("start_virtual_time") ? time_value(j.at("start_virtual_time")) : 0;
        auto res = engine_.start_async(seed, c, start);
        send(r, res, 202);
    });
    server_->Post("/api/v1/playback/pause", [this](const auto& req, auto& r) { send(r, engine_.pause(body(req))); });
    server_->Post("/api/v1/playback/play", [this](const auto& req, auto& r) { send(r, engine_.play(body(req))); });
    server_->Post("/api/v1/playback/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/api/v1/playback/reset", [this](const auto&, auto& r) { send(r, engine_.reset()); });
    server_->Post("/api/v1/playback/seek", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.seek(time_value(j.at("target_time")), j.value("play", false)));
    });

    // Advance a fixed amount of virtual time and hold there.
    server_->Post("/api/v1/playback/step", [this](const auto& req, auto& r) {
        const auto j = body(req);
        const auto seconds = j.contains("seconds") ? j.at("seconds").template get<std::int64_t>() : 60;
        if (seconds < 1 || seconds > 3600) throw std::invalid_argument("seconds must be in [1, 3600]");
        send(r, engine_.step(static_cast<std::uint32_t>(seconds)));
    });

    // World regeneration. The observer may ask for a new world, but may not
    // choose anything about it: the seed comes from the secure generator and
    // every other parameter is copied from the run the operator started. That
    // keeps scenario configuration with the CLI. Operators can disable this
    // entirely with DSTNS_DISABLE_WORLD_REGENERATION=1.
    const bool regeneration_disabled = [] {
        const char* v = std::getenv("DSTNS_DISABLE_WORLD_REGENERATION");
        return v && std::string(v) == "1";
    }();
    server_->Post("/api/v1/world/regenerate", [this, regeneration_disabled](const auto& req, auto& r) {
        if (regeneration_disabled) {
            send(r, {{"api_version", "1.0"},
                     {"error", {{"code", "WORLD_REGENERATION_DISABLED"},
                                {"message", "World regeneration is disabled by the operator."}}}}, 403);
            return;
        }
        send(r, engine_.regenerate_world(body(req)), 202);
    });
    server_->Get("/api/v1/world/status", [this, regeneration_disabled](const auto&, auto& r) {
        auto status = engine_.world_status();
        status["data"]["enabled"] = !regeneration_disabled;
        send(r, status);
    });

    // Control API
    server_->Put("/api/v1/control/tick-rate", [this](const auto& req, auto& r) {
        send(r, engine_.set_tick_rate(body(req).at("tick_rate")));
    });
    server_->Post("/api/v1/control/day", [this](const auto& req, auto& r) {
        send(r, engine_.set_day(body(req).at("day")));
    });
    server_->Put(R"(/api/v1/control/modules/([a-z-]+))", [this](const auto& req, auto& r) {
        send(r, engine_.set_module(req.matches[1], body(req).at("enabled")));
    });
    server_->Post(R"(/api/v1/control/modules/([a-z-]+)/(enable|disable))", [this](const auto& req, auto& r) {
        send(r, engine_.set_module(req.matches[1], req.matches[2] == "enable"));
    });
    server_->Post("/api/v1/control/events/weather", [this](const auto& req, auto& r) {
        auto j = body(req);
        const double default_rad = 350.0;
        const double minutes = j.value("duration_virtual_minutes", 60.0);
        // Checked as a double: converting a negative or enormous value to an
        // unsigned integer first would be undefined.
        if (!std::isfinite(minutes) || minutes < 1 || minutes > 1440)
            throw std::invalid_argument("duration_virtual_minutes must be in [1, 1440]");
        send(r, engine_.add_weather(
            NodeId{j.at("epicenter_node")},
            j.value("intensity", 0.85),
            j.value("radius_m", default_rad),
            static_cast<std::uint32_t>(minutes),
            j.value("flood_gain", 0.5)
        ), 202);
    });
    server_->Post("/api/v1/control/events/traffic", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto target = j.at("target");
        if (target.at("type") != "edge") throw std::invalid_argument("V1 traffic overlays require an edge target");
        const auto pressure = j.at("congestion_pressure").get<double>();
        if (!std::isfinite(pressure) || pressure < 0 || pressure > 1) {
            throw std::invalid_argument("congestion_pressure must be in [0,1]");
        }
        send(r, engine_.override_edge(EdgeId{target.at("id").get<std::uint32_t>()}, 1.0, 1.0 - .75 * pressure, false), 202);
    });
    auto edge_override_handler = [this](const auto& req, auto& r) {
        auto j = body(req);
        const auto edge_id = path_id(req.matches[1]);
        send(r, engine_.override_edge(
            EdgeId{edge_id},
            j.value("speed_multiplier", 1.0),
            j.value("capacity_multiplier", 1.0),
            j.value("closed", false)
        ));
    };
    server_->Put(R"(/api/v1/control/edges/(\d+))", edge_override_handler);
    server_->Post(R"(/api/v1/control/edges/(\d+)/override)", edge_override_handler);
    server_->Post("/api/v1/playback/prepare", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        const auto seed = seed_from(j);
        auto c = config_from(j);
        send(r, engine_.prepare(seed, c), 200);
    });

    server_->Post(R"(/api/v1/control/signals/(\d+)/toggle)", [this](const auto& req, auto& r) {
        const auto node_id = path_id(req.matches[1]);
        send(r, engine_.toggle_signal(NodeId{node_id}));
    });
    server_->Post(R"(/api/v1/control/signals/(\d+))", [this](const auto& req, auto& r) {
        const auto node_id = path_id(req.matches[1]);
        send(r, engine_.toggle_signal(NodeId{node_id}));
    });
    server_->Post("/api/v1/control/events/surge", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.trigger_surge(
            NodeId{j.at("node_id")},
            j.value("factor", 1.8),
            j.value("radius_m", 350.0),
            j.value("duration_s", 1800u)
        ), 202);
    });
    server_->Post("/api/v1/control/transit/route", [](const auto&, auto& r) {
        r.set_header("Deprecation","true");
        send(r,{{"error",{{"code","TRANSIT_API_RETIRED"},{"message","Transit route dispatch is no longer supported."}}}},410);
    });

    // Read as a signed integer: nlohmann converts -1 to an unsigned type by
    // wrapping it, which would undo the whole history.
    auto history_count = [](const json& j) {
        const auto count = j.value("count", std::int64_t{1});
        if (count < 1 || count > 10000) throw std::invalid_argument("count must be in [1, 10000]");
        return static_cast<std::uint32_t>(count);
    };
    server_->Post("/api/v1/control/undo", [this, history_count](const auto& req, auto& r) {
        send(r, engine_.undo(history_count(body(req))));
    });
    server_->Post("/api/v1/control/redo", [this, history_count](const auto& req, auto& r) {
        send(r, engine_.redo(history_count(body(req))));
    });
    server_->Get("/api/v1/control/history", [this](const auto&, auto& r) {
        send(r, engine_.history());
    });

    // View API
    server_->Get("/api/v1/view/run", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Get("/api/v1/view/config", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Get("/api/v1/view/manifest", [this](const auto&, auto& r) { send(r, engine_.manifest()); });
    server_->Get("/api/v1/view/topology", [this](const auto&, auto& r) { send(r, engine_.topology()); });
    server_->Get("/api/v1/topology", [this](const auto&, auto& r) { send(r, engine_.topology()); });
    server_->Get("/api/v1/view/network", [this](const auto&, auto& r) { send(r, engine_.topology()); });
    server_->Get("/api/v1/view/map/full", [this](const auto&, auto& r) { send(r, engine_.topology()); });
    server_->Get("/api/v1/view/snapshot", [this](const auto&, auto& r) {
        // Snapshots are the bulk of what the observer consumes, so their size
        // and cadence are what ASB reports as the delivered data rate.
        send(r, engine_.snapshot());
        engine_.note_delivery(r.body.size());
    });
    server_->Get("/api/v1/view/global", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/world", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/all", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/global.json", [this](const auto&, auto& r) { send(r, engine_.global_view()); });

    server_->Get("/api/v1/view/nodes", [this](const auto& req, auto& r) {
        send(r, engine_.nodes(
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",250,1000)
        ));
    });
    server_->Get("/api/v1/view/edges", [this](const auto& req, auto& r) {
        send(r, engine_.edges(
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",250,1000)
        ));
    });
    server_->Get(R"(/api/v1/view/nodes/(\d+))", [this](const auto& req, auto& r) {
        const auto id = path_id(req.matches[1]);
        auto result = engine_.nodes(id, 1);
        if (result["data"]["items"].empty()) throw std::out_of_range("unknown node");
        send(r, result);
    });
    server_->Get(R"(/api/v1/view/edges/(\d+))", [this](const auto& req, auto& r) {
        const auto id = path_id(req.matches[1]);
        auto result = engine_.edges(id, 1);
        if (result["data"]["items"].empty()) throw std::out_of_range("unknown edge");
        send(r, result);
    });

    // Places. The classified view of the world's features: what each one is,
    // what the demand model believes about it, and why.
    auto places_handler = [this](const httplib::Request& req, httplib::Response& r) {
        const auto kind = req.has_param("kind") ? req.get_param_value("kind") : std::string{};
        if (!kind.empty() && !std::regex_match(kind, std::regex("[a-z_]{1,32}")))
            throw std::invalid_argument("invalid place kind");
        send(r, engine_.places(
            kind,
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",500,2000)
        ));
    };
    server_->Get("/api/v1/view/places", places_handler);
    server_->Get("/api/v1/places", places_handler);
    server_->Get("/api/v1/view/place-kinds", [this](const auto&, auto& r) { send(r, engine_.place_kinds()); });
    // Stops are places too; this is the same data narrowed to one kind, so a
    // transit client need not know the taxonomy to ask the obvious question.
    server_->Get("/api/v1/view/stops", [this](const httplib::Request& req, httplib::Response& r) {
        send(r, engine_.places("bus_stop",
            page_parameter(req,"offset",0,std::numeric_limits<std::size_t>::max()),
            page_parameter(req,"limit",500,2000)));
    });

    for (const auto* kind : {"traffic", "weather", "buildings", "bus-stops", "signals", "events", "metrics", "incidents", "congestion"}) {
        const auto path = std::string("/api/v1/view/") + kind;
        server_->Get(path, [this, kind](const auto&, auto& r) { send(r, engine_.catalog(kind)); });
    }

    server_->Get("/api/v1/view/event-queue",[this](const auto& req,auto& r){
        auto number=[&](const char* key,std::size_t fallback,std::size_t max){if(!req.has_param(key))return fallback;auto value=req.get_param_value(key);if(!std::regex_match(value,std::regex("[0-9]{1,6}")))throw std::invalid_argument("invalid event pagination");auto n=std::stoul(value);if(n>max)throw std::invalid_argument("event pagination out of range");return n;};
        const auto view=req.has_param("view")?req.get_param_value("view"):"future";
        const auto category=req.has_param("category")?req.get_param_value("category"):"all";
        if(view!="future"&&view!="history")throw std::invalid_argument("view must be future or history");
        if(category!="all"&&category!="signals"&&category!="demand"&&category!="incidents"&&category!="weather"&&category!="flooding"&&category!="system")throw std::invalid_argument("invalid event category");
        const auto limit=number("limit",50,200);if(!limit)throw std::invalid_argument("limit must be positive");
        send(r,engine_.scheduled_events(view=="future",category,number("offset",0,100000),limit));
    });

    // News API
    server_->Get("/api/v1/news", [this](const auto& req, auto& r) {
        send(r, engine_.news(
            unsigned_parameter(req, "since_news_id", 0),
            static_cast<std::size_t>(std::min<std::uint64_t>(500, unsigned_parameter(req, "limit", 100)))
        ));
    });

    // Logs API
    server_->Get("/api/v1/view/logs/system", [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"data", {{"lines", logger_.system_tail(250)}}}});
    });
    server_->Get("/api/v1/view/logs/events", [this](const auto& req, auto& r) {
        const auto limit = static_cast<std::size_t>(std::min<std::uint64_t>(1000, unsigned_parameter(req, "limit", 100)));
        send(r, {{"ok", true}, {"data", {{"items", logger_.rows("event_log", limit)}}}});
    });
    server_->Get("/api/v1/view/logs/api", [this](const auto& req, auto& r) {
        const auto limit = static_cast<std::size_t>(std::min<std::uint64_t>(1000, unsigned_parameter(req, "limit", 100)));
        send(r, {{"ok", true}, {"data", {{"items", logger_.rows("api_log", limit)}}}});
    });

    // Streaming
    server_->Get("/api/v1/view/stream", [this](const auto&, auto& r) {
        r.set_header("Connection", "close");
        r.set_content("retry: 1000\nevent: snapshot\ndata: " + dump_json(engine_.snapshot()) + "\n\n", "text/event-stream");
    });
    server_->Get("/api/v1/news/stream", [this](const auto&, auto& r) {
        r.set_header("Connection", "close");
        r.set_content("retry: 1000\nevent: news\ndata: " + dump_json(engine_.news(0, 100)) + "\n\n", "text/event-stream");
    });


}

void ApiServer::listen(const std::string& host, std::uint16_t port) {
    loopback_only_->store(host == "localhost" || host == "::1" || host.rfind("127.", 0) == 0);
    logger_.system("INFO", "api", "listening on http://" + host + ":" + std::to_string(port));
    if (!server_->listen(host, port) && !stopping_) {
        throw std::runtime_error("API server failed to listen on " + host + ":" + std::to_string(port) + " (port may be in use by another process)");
    }
}

void ApiServer::stop() {
    if (stopping_.exchange(true)) return;
    if (server_) server_->stop();
}

} // namespace dstns
