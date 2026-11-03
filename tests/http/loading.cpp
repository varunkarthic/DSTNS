// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Slow real-map startup and regeneration under concurrent HTTP polling.
//
// Uses an isolated server and cache, and a map file held back behind a FIFO, never a public endpoint. Exercises the
// real HTTP thread pool and engine, including a reset during I/O.
#include "harness.hpp"

#include <sys/stat.h>

#include <future>

using namespace check;

namespace {

// The map, behind a FIFO held open, so that reading it waits until it is released.
struct Gate {
    fs::path path;
    int fd = -1;
    explicit Gate(fs::path p) : path(std::move(p)) {
        fs::remove(path);
        EXPECT(::mkfifo(path.c_str(), 0600) == 0);
        fd = ::open(path.c_str(), O_RDWR);
    }
    void release(const std::string& xml) {
        if (fd < 0) return;
        for (std::size_t sent = 0; sent < xml.size();) {
            const auto wrote = ::write(fd, xml.data() + sent, xml.size() - sent);
            if (wrote <= 0) break;
            sent += static_cast<std::size_t>(wrote);
        }
        ::close(fd);
        fd = -1;
    }
    ~Gate() {
        if (fd >= 0) ::close(fd);
    }
};

} // namespace

int main() {
    TempDir tmp("dstns-loading-http-");
    Server server(tmp.path, {"--map-cache", "keep"});
    const auto call = [&](const std::string& route, std::optional<json> data = none, double timeout = 2) {
        return server.op(data ? "POST" : "GET", route, data, timeout);
    };
    const auto lifecycle = [&] { return call("/api/v1/playback/status").data().at("lifecycle").get<std::string>(); };
    const auto preparing = [&] { return call("/api/v1/system/map-status").data().at("preparation") == "building"; };
    const auto path = tmp / "delayed.osm.xml";
    const auto xml = read(root() / "tests/fixtures/roads.osm.xml");
    const json payload{{"seed", "12345"}, {"playback_duration_seconds", 3600}, {"map", {{"osm_file", path.string()}}}};
    {
        Gate gate(path);
        auto start = std::async(std::launch::async, [&] { return call("/api/v1/playback/start", payload, 10); });
        until(preparing, 8, "the map to be read");
        std::vector<std::future<Reply>> readers;
        for (int round = 0; round < 6; ++round) {
            for (const char* route : {"/api/v1/playback/status", "/api/v1/view/snapshot", "/api/v1/view/topology", "/api/v1/system/map-status", "/health"}) {
                readers.push_back(std::async(std::launch::async, [&, route] { return call(route, none, 3); }));
            }
        }
        for (auto& reader : readers) {
            const auto reply = reader.get();
            EXPECT(reply.status == 200, reply);
        }
        EXPECT(lifecycle() == "PREPARING");
        EXPECT(call("/api/v1/playback/start", payload).status == 409);
        gate.release(xml);
        EXPECT(start.get().status == 202);
    }
    until([&] { return lifecycle() == "RUNNING"; }, 8, "the run");
    const auto old = call("/api/v1/playback/status").body.at("run_id");
    fs::remove(path);
    write(path, xml);
    EXPECT(call("/api/v1/world/regenerate", json::object()).status == 202);
    const auto ready = until([&]() -> std::optional<json> {
        auto status = call("/api/v1/world/status").data();
        if (status.at("state") == "ready") return status;
        return std::nullopt;
    }, 8, "the new world");
    EXPECT(ready->at("run_id") != old);
    EXPECT(lifecycle() == "PAUSED");
    // Hold back a replacement; a reset must cancel its eventual installation.
    {
        Gate gate(path);
        EXPECT(call("/api/v1/world/regenerate", json::object()).status == 202);
        until(preparing, 8, "the replacement to be read");
        EXPECT(call("/api/v1/playback/reset", json::object()).status == 200);
        gate.release(xml);
    }
    const auto cancelled = until([&]() -> std::optional<json> {
        auto status = call("/api/v1/world/status").data();
        if (status.at("state") == "failed") return status;
        return std::nullopt;
    }, 8, "the replacement to be cancelled");
    EXPECT(cancelled->at("error").at("code") == "WORLD_CANCELLED", *cancelled);
    EXPECT(lifecycle() == "IDLE");
    // A missing map is an error that stays, for a browser opened earlier to see.
    fs::remove(path);
    EXPECT(call("/api/v1/playback/start", payload).status == 202);
    const auto failed = until([&]() -> std::optional<json> {
        auto status = call("/api/v1/playback/status").data();
        if (status.at("lifecycle") == "IDLE" && !status.at("preparation_error").get<std::string>().empty()) return status;
        return std::nullopt;
    }, 8, "the start to fail");
    EXPECT(contains(failed->at("preparation_error").get<std::string>(), "cannot open OSM"), *failed);
    write(path, xml);
    EXPECT(call("/api/v1/playback/start", payload).status == 202);
    EXPECT(call("/api/v1/playback/status").data().at("preparation_error") == "");
    std::cout << "Loading HTTP: 30 concurrent reads, startup, conflict, regeneration, cancellation, failure and retry passed\n";
}
