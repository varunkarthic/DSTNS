#include "dstns/api.hpp"
#include "dstns/sumo_bridge.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <chrono>
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
    r.set_content(copy.dump(), "application/json; charset=utf-8");
}

json body(const httplib::Request& r) {
    if (r.body.empty()) return json::object();
    return json::parse(r.body);
}

std::uint32_t time_value(const json& v) {
    if (v.is_number_unsigned()) return v.get<std::uint32_t>();
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
    if (j.contains("day")) {
        if (j.at("day").is_string() && j.at("day") == "auto") c.day = -1;
        else c.day = j.at("day");
    }
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
    if (!dist.empty() && std::filesystem::exists(dist / "assets")) {
        server_->set_mount_point("/assets", (dist / "assets").string());
    }

    auto index_handler = [dist](const httplib::Request&, httplib::Response& r) {
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
    server_->Get("/", index_handler);
    server_->Get("/index.html", index_handler);

    server_->set_default_headers({
        {"Access-Control-Allow-Origin", "*"},
        {"Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Authorization"},
        {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"},
        {"Cache-Control", "no-store"}
    });

    server_->Options(R"(.*)", [](const auto&, auto& r) {
        r.status = 204;
    });

    server_->set_exception_handler([this](const auto& req, auto& res, std::exception_ptr ep) {
        std::string message = "internal server error", code = "INTERNAL_ERROR";
        int status = 500;
        try {
            if (ep) std::rethrow_exception(ep);
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
            {"product", "Deterministic Simulated Environment"},
            {"version", "1.0.0"},
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
            {"product", "Deterministic Simulated Environment"},
            {"version", "1.0.0"},
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

    // SUMO Microscopic Export & Simulation
    server_->Post("/api/v1/export/sumo", [this](const auto& req, auto& r) {
        auto j = body(req);
        std::filesystem::path dir = j.value("directory", "data/sumo_export");
        send(r, engine_.export_sumo(dir));
    });
    server_->Post("/api/v1/system/sumo-simulate", [this](const auto& req, auto& r) {
        auto j = body(req);
        std::filesystem::path dir = j.value("directory", "data/sumo_run");
        std::uint32_t begin_s = j.value("begin_s", 0);
        std::uint32_t end_s = j.value("end_s", 3600);
        send(r, engine_.sumo_simulate(dir, begin_s, end_s));
    });

    auto terminate_handler = [this](const auto&, auto& r) {
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"product", "Deterministic Simulated Environment"},
            {"status", "TERMINATING"},
            {"message", "Deterministic Simulated Environment server is shutting down gracefully."}
        });
        engine_.terminate();
        std::thread([this]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(150));
            server_->stop();
        }).detach();
    };
    server_->Get("/terminate", terminate_handler);
    server_->Post("/terminate", terminate_handler);
    server_->Get("/api/v1/system/terminate", terminate_handler);
    server_->Post("/api/v1/system/terminate", terminate_handler);

    // Playback API
    server_->Get("/api/v1/playback/status", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Post("/api/v1/playback/start", [this](const httplib::Request& req, httplib::Response& r) {
        auto j = body(req);
        Seed128 seed;
        if (!j.contains("seed") || j.at("seed").is_null()) {
            seed = Seed128::secure();
        } else if (j.at("seed").is_string()) {
            const auto s = j.at("seed").get<std::string>();
            if (s.empty() || s == "auto" || s == "0x0" || s == "random") {
                seed = Seed128::secure();
            } else {
                seed = Seed128::parse(s);
            }
        } else if (j.at("seed").is_number_unsigned()) {
            const auto val = j.at("seed").get<std::uint64_t>();
            seed = (val == 0) ? Seed128::secure() : Seed128{0, val};
        } else {
            seed = Seed128::secure();
        }
        auto c = config_from(j);
        const auto start = j.contains("start_virtual_time") ? time_value(j.at("start_virtual_time")) : 0;
        auto res = engine_.start(seed, c, start);
        std::thread([this]() {
            try {
                (void)engine_.sumo_simulate("data/sumo_run", 0, 3600);
            } catch (...) {}
        }).detach();
        send(r, res, 202);
    });
    server_->Post("/api/v1/playback/pause", [this](const auto&, auto& r) { send(r, engine_.pause()); });
    server_->Post("/api/v1/playback/play", [this](const auto&, auto& r) { send(r, engine_.play()); });
    server_->Post("/api/v1/playback/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/stop", [this](const auto&, auto& r) { send(r, engine_.stop()); });
    server_->Post("/api/v1/playback/reset", [this](const auto&, auto& r) { send(r, engine_.reset()); });
    server_->Post("/api/v1/playback/seek", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.seek(time_value(j.at("target_time")), j.value("play", false)));
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
        send(r, engine_.add_weather(
            NodeId{j.at("epicenter_node")},
            j.value("intensity", 0.85),
            j.value("radius_m", default_rad),
            j.value("duration_virtual_minutes", 60.0),
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
        const auto edge_id = static_cast<std::uint32_t>(std::stoul(req.matches[1]));
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
        Seed128 seed;
        if (!j.contains("seed") || j.at("seed").is_null()) {
            seed = Seed128::secure();
        } else if (j.at("seed").is_string()) {
            const auto s = j.at("seed").get<std::string>();
            if (s.empty() || s == "auto" || s == "0x0" || s == "random") {
                seed = Seed128::secure();
            } else {
                seed = Seed128::parse(s);
            }
        } else if (j.at("seed").is_number_unsigned()) {
            const auto val = j.at("seed").get<std::uint64_t>();
            seed = (val == 0) ? Seed128::secure() : Seed128{0, val};
        } else {
            seed = Seed128::secure();
        }
        auto c = config_from(j);
        send(r, engine_.prepare(seed, c), 200);
    });

    server_->Post(R"(/api/v1/control/signals/(\d+)/toggle)", [this](const auto& req, auto& r) {
        const auto node_id = static_cast<std::uint32_t>(std::stoul(req.matches[1]));
        send(r, engine_.toggle_signal(NodeId{node_id}));
    });
    server_->Post(R"(/api/v1/control/signals/(\d+))", [this](const auto& req, auto& r) {
        const auto node_id = static_cast<std::uint32_t>(std::stoul(req.matches[1]));
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
    server_->Post("/api/v1/control/transit/route", [this](const auto& req, auto& r) {
        auto j = body(req);
        const std::vector<std::uint32_t> nodes = j.at("nodes");
        const auto bus_id = j.value("bus_id", "BUS-101");
        const auto label = j.value("label", "Transit Line " + bus_id);
        const auto res = engine_.validate_transit_route(nodes, bus_id, label);
        send(r, res, res.value("valid", false) ? 200 : 400);
    });

    server_->Post("/api/v1/control/undo", [this](const auto& req, auto& r) {
        send(r, engine_.undo(body(req).value("count", std::uint32_t{1})));
    });
    server_->Post("/api/v1/control/redo", [this](const auto& req, auto& r) {
        send(r, engine_.redo(body(req).value("count", std::uint32_t{1})));
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
    server_->Get("/api/v1/view/snapshot", [this](const auto&, auto& r) { send(r, engine_.snapshot()); });
    server_->Get("/api/v1/view/global", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/world", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/all", [this](const auto&, auto& r) { send(r, engine_.global_view()); });
    server_->Get("/api/v1/view/global.json", [this](const auto&, auto& r) { send(r, engine_.global_view()); });

    server_->Get("/api/v1/view/nodes", [this](const auto& req, auto& r) {
        send(r, engine_.nodes(
            req.has_param("offset") ? std::stoul(req.get_param_value("offset")) : 0,
            req.has_param("limit") ? std::min<std::size_t>(1000, std::stoul(req.get_param_value("limit"))) : 250
        ));
    });
    server_->Get("/api/v1/view/edges", [this](const auto& req, auto& r) {
        send(r, engine_.edges(
            req.has_param("offset") ? std::stoul(req.get_param_value("offset")) : 0,
            req.has_param("limit") ? std::min<std::size_t>(1000, std::stoul(req.get_param_value("limit"))) : 250
        ));
    });
    server_->Get(R"(/api/v1/view/nodes/(\d+))", [this](const auto& req, auto& r) {
        const auto id = std::stoul(req.matches[1]);
        auto result = engine_.nodes(id, 1);
        if (result["data"]["items"].empty()) throw std::out_of_range("unknown node");
        send(r, result);
    });
    server_->Get(R"(/api/v1/view/edges/(\d+))", [this](const auto& req, auto& r) {
        const auto id = std::stoul(req.matches[1]);
        auto result = engine_.edges(id, 1);
        if (result["data"]["items"].empty()) throw std::out_of_range("unknown edge");
        send(r, result);
    });

    for (const auto* kind : {"traffic", "weather", "buildings", "bus-stops", "signals", "events", "metrics", "incidents"}) {
        const auto path = std::string("/api/v1/view/") + kind;
        server_->Get(path, [this, kind](const auto&, auto& r) { send(r, engine_.catalog(kind)); });
    }

    // News API
    server_->Get("/api/v1/news", [this](const auto& req, auto& r) {
        send(r, engine_.news(
            req.has_param("since_news_id") ? std::stoull(req.get_param_value("since_news_id")) : 0,
            req.has_param("limit") ? std::min<std::size_t>(500, std::stoul(req.get_param_value("limit"))) : 100
        ));
    });

    // Logs API
    server_->Get("/api/v1/view/logs/system", [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"data", {{"lines", logger_.system_tail(250)}}}});
    });
    server_->Get("/api/v1/view/logs/events", [this](const auto& req, auto& r) {
        const auto limit = req.has_param("limit") ? std::min<std::size_t>(1000, std::stoul(req.get_param_value("limit"))) : 100;
        send(r, {{"ok", true}, {"data", {{"items", logger_.rows("event_log", limit)}}}});
    });
    server_->Get("/api/v1/view/logs/api", [this](const auto& req, auto& r) {
        const auto limit = req.has_param("limit") ? std::min<std::size_t>(1000, std::stoul(req.get_param_value("limit"))) : 100;
        send(r, {{"ok", true}, {"data", {{"items", logger_.rows("api_log", limit)}}}});
    });

    // Streaming
    server_->Get("/api/v1/view/stream", [this](const auto&, auto& r) {
        r.set_header("Connection", "close");
        r.set_content("retry: 1000\nevent: snapshot\ndata: " + engine_.snapshot().dump() + "\n\n", "text/event-stream");
    });
    server_->Get("/api/v1/news/stream", [this](const auto&, auto& r) {
        r.set_header("Connection", "close");
        r.set_content("retry: 1000\nevent: news\ndata: " + engine_.news(0, 100).dump() + "\n\n", "text/event-stream");
    });

    // Terminate
    auto terminate = [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"message", "DSTNS terminating gracefully"}});
        engine_.terminate();
        std::thread([this] {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            stop();
        }).detach();
    };
    server_->Post("/api/v1/system/terminate", terminate);
    server_->Post("/terminate", terminate);
}

void ApiServer::listen(const std::string& host, std::uint16_t port) {
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
