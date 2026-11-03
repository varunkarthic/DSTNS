// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// What a container needs beside the server, in the server itself:
//
//   dstns_server --run [--seed S] [--day-type weekday|weekend] [--speed X] [--duration S] [--osm-file F] [--status]
//       Start a run, as the launcher does on a workstation: it reads the operator credential the server wrote, builds
//       the start request from flags or DSTNS_* variables, and follows preparation (the map download too) until the
//       run is live. A run already in progress is replaced unless --quiet-if-active is given, which the entrypoint
//       uses so that restarting a container never discards a run someone is watching.
//   dstns_server --probe
//       Exit 0 if the server on DSTNS_PORT answers /health, for the container's health check.

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <thread>

namespace {

using json = nlohmann::json;

int port() {
    const char* value = std::getenv("DSTNS_PORT");
    const int parsed = value ? std::atoi(value) : 0;
    return parsed > 0 && parsed < 65536 ? parsed : 8090;
}

std::string env(const char* name, const char* fallback) {
    const char* value = std::getenv(name);
    return value ? value : fallback;
}

void say(const std::string& message) { std::cout << "[dstns-run] " << message << std::endl; }

struct Reply {
    int status = 0;
    json body = json::object();
};

std::optional<Reply> call(const std::string& path, const std::optional<json>& payload = std::nullopt, const std::string& token = "", int timeout_s = 10) {
    httplib::Client client("127.0.0.1", port());
    client.set_connection_timeout(timeout_s);
    client.set_read_timeout(timeout_s);
    httplib::Headers headers;
    if (!token.empty()) headers.emplace("X-DSTNS-Operator", token);
    const auto result = payload ? client.Post(path, headers, payload->dump(), "application/json") : client.Get(path, headers);
    if (!result) return std::nullopt;
    Reply reply{result->status};
    reply.body = json::parse(result->body, nullptr, false);
    if (reply.body.is_discarded()) reply.body = json::object();
    return reply;
}

json status() {
    const auto reply = call("/api/v1/playback/status");
    return reply && reply->body.contains("data") ? reply->body["data"] : json::object();
}

std::optional<double> number(const std::string& text) {
    try {
        std::size_t used = 0;
        const double value = std::stod(text, &used);
        return used == text.size() ? std::optional(value) : std::nullopt;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

double bounded(const std::string& text, double low, double high, const std::string& name) {
    const auto value = number(text);
    if (!value) {
        say(name + " must be a number, got '" + text + "'");
        std::exit(2);
    }
    if (*value < low || *value > high) {
        std::ostringstream message;
        message << name << " must be in [" << low << ", " << high << "], got " << *value;
        say(message.str());
        std::exit(2);
    }
    return *value;
}

const char* kUsage =
    "Usage: dstns_server --run [--seed S] [--day-type weekday|weekend] [--speed X] [--duration S] [--osm-file F] [--status]\n"
    "Start a DSTNS run in this container. Each option defaults to its DSTNS_* variable.\n";

} // namespace

int container_probe_main() {
    const auto reply = call("/health", std::nullopt, "", 2);
    return reply && reply->status == 200 ? 0 : 1;
}

int container_run_main(int argc, char** argv) {
    std::string seed = env("DSTNS_SEED", "auto"), day_type = env("DSTNS_DAY_TYPE", "weekday"), speed_text = env("DSTNS_SPEED", "1"),
                duration_text = env("DSTNS_DURATION", "3600"), osm_file = env("DSTNS_OSM_FILE", "auto");
    bool show_status = false, wait_for_server = false, quiet_if_active = false;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        const auto take = [&](std::string& into) {
            if (i + 1 >= argc) {
                say(arg + " needs a value");
                std::exit(2);
            }
            into = argv[++i];
        };
        if (arg == "--run") continue;
        if (arg == "--seed") take(seed);
        else if (arg == "--day-type") take(day_type);
        else if (arg == "--speed") take(speed_text);
        else if (arg == "--duration") take(duration_text);
        else if (arg == "--osm-file") take(osm_file);
        else if (arg == "--status") show_status = true;
        else if (arg == "--wait-for-server") wait_for_server = true;
        else if (arg == "--quiet-if-active") quiet_if_active = true;
        else if (arg == "--help" || arg == "-h") {
            std::cout << kUsage;
            return 0;
        } else {
            std::cerr << kUsage << "unknown argument " << arg << "\n";
            return 2;
        }
    }
    if (day_type != "weekday" && day_type != "weekend") {
        say("--day-type must be weekday or weekend, got '" + day_type + "'");
        return 2;
    }

    if (wait_for_server) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        for (;;) {
            if (const auto reply = call("/health", std::nullopt, "", 2); reply && reply->body.value("ok", false)) break;
            if (std::chrono::steady_clock::now() > deadline) {
                say("the server did not become healthy");
                return 1;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
    }
    const auto current = status();
    if (show_status) {
        std::cout << current.dump(2) << std::endl;
        return 0;
    }
    const auto lifecycle = current.value("lifecycle", std::string());
    if (lifecycle == "RUNNING" || lifecycle == "PAUSED" || lifecycle == "PREPARING" || lifecycle == "READY") {
        if (quiet_if_active) {
            say("a run is already " + lifecycle + "; leaving it alone");
            return 0;
        }
        const auto run = current.value("run_id", std::string());
        say("replacing the current run (" + (run.empty() ? std::string("preparing") : run) + ")");
        call("/api/v1/playback/reset", json::object());
    }

    const double speed = bounded(speed_text, 0.01, 5, "--speed");
    const int duration = static_cast<int>(bounded(duration_text, 60, 3600, "--duration"));
    const json payload = {
        {"seed", seed.empty() || seed == "auto" || seed == "random" ? "auto" : seed},
        {"day", day_type == "weekend" ? 1 : 0},
        {"tick_rate", speed},
        {"playback_duration_seconds", duration},
        {"map", {{"osm_file", osm_file}, {"cache_dir", "/app/data/maps"}}},
    };
    std::string token;
    if (std::ifstream in(env("DSTNS_LOGS_DIR", "/app/logs") + "/operator.token"); in) std::getline(in, token);
    const auto started = call("/api/v1/playback/start", payload, token, 30);
    if (!started || started->status != 202) {
        const auto message = started && started->body.contains("error") ? started->body["error"].value("message", started->body.dump()) : std::string("no answer");
        say("start refused (" + std::to_string(started ? started->status : 0) + "): " + message);
        return 1;
    }
    const auto chosen = started->body.contains("data") && started->body["data"].contains("seed") ? started->body["data"]["seed"] : payload["seed"];
    say("seed " + (chosen.is_string() ? chosen.get<std::string>() : chosen.dump()) + ": preparing the world");

    std::string last;
    for (;;) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        const auto state = status();
        const auto now = state.value("lifecycle", std::string());
        if (now == "PREPARING") {
            const auto reply = call("/api/v1/system/map-status");
            const auto fetch = reply && reply->body.contains("data") ? reply->body["data"] : json::object();
            auto line = fetch.value("preparation", std::string());
            if (fetch.value("active", false)) {
                const auto where = fetch.value("city", std::string()) + ", " + fetch.value("country", std::string());
                const auto phase = fetch.value("phase", std::string());
                // One line per 4 MiB, rather than one per poll.
                if (phase == "download") line = "downloading " + where + ": " + std::to_string(fetch.value("bytes", 0ull) / (4ull << 20) * 4) + " MiB";
                else if (phase == "parse") line = "validating the " + where + " extract";
                else line = "contacting OpenStreetMap for " + where;
            }
            if (!line.empty() && line != last) {
                say(line);
                last = line;
            }
            continue;
        }
        if (now == "RUNNING" || now == "PAUSED" || now == "READY") {
            say("run " + state.value("run_id", std::string()) + " is " + now + "; open the observer on the port published for container port "
                + std::to_string(port()) + " (http://localhost:" + std::to_string(port()) + "/ by default)");
            return 0;
        }
        const auto error = state.value("preparation_error", std::string());
        say("preparation failed: " + (error.empty() ? now : error));
        return 1;
    }
}
