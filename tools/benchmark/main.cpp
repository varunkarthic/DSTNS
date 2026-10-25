// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// DSTNS load benchmark.
//
// Measures the system under increasing load along four axes and prints a table
// for each; --json writes everything, with the machine and build, to a file.
//
//   network    district size: compile, physics tick, seek, snapshot, topology
//   events     storms and incidents per day at a fixed size
//   observers  concurrent clients polling the snapshot while the clock runs
//   narrator   narration queue and cache; with --narrator, a real model too
//
// Usage:
//   dstns_benchmark [--quick] [--json FILE] [--narrator fm|http://HOST:PORT|unix:/PATH]
//                   [--suite network,events,observers,narrator] [GRID ...]

#include "dstns/build_info.hpp"
#include "dstns/engine.hpp"
#include "dstns/graph.hpp"
#include "dstns/logging.hpp"
#include "dstns/narrator.hpp"
#include "dstns/platform.hpp"
#include "dstns/scenario.hpp"
#include "dstns/utf8.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numeric>
#include <set>
#include <sstream>
#include <thread>

#include <unistd.h>

namespace {

using Clock = std::chrono::steady_clock;
using json = nlohmann::json;

double ms_since(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

double quantile(std::vector<double> values, double q) {
    if (values.empty()) return 0;
    std::sort(values.begin(), values.end());
    const auto index = std::min(values.size() - 1, static_cast<std::size_t>(q * double(values.size() - 1) + 0.5));
    return values[index];
}

std::string fixed(double v, int digits = 1) {
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.*f", digits, v);
    return buffer;
}

std::string mib(std::size_t bytes) { return fixed(double(bytes) / (1024.0 * 1024.0), 2) + " MiB"; }

/// A plain fixed-width table: the first row is the header.
void print_table(const std::string& title, const std::vector<std::vector<std::string>>& rows) {
    std::vector<std::size_t> width;
    for (const auto& row : rows)
        for (std::size_t i = 0; i < row.size(); ++i) {
            if (width.size() <= i) width.push_back(0);
            width[i] = std::max(width[i], row[i].size());
        }
    std::cout << "\n" << title << "\n";
    for (std::size_t r = 0; r < rows.size(); ++r) {
        std::cout << "  ";
        for (std::size_t i = 0; i < rows[r].size(); ++i) {
            const auto& cell = rows[r][i];
            const auto pad = std::string(width[i] - cell.size(), ' ');
            std::cout << (i ? pad + cell : cell + pad) << (i + 1 < rows[r].size() ? "  " : "");
        }
        std::cout << "\n";
        if (r == 0) {
            std::cout << "  ";
            for (std::size_t i = 0; i < width.size(); ++i) std::cout << std::string(width[i], '-') << (i + 1 < width.size() ? "  " : "");
            std::cout << "\n";
        }
    }
}

const auto kSeed = dstns::Seed128::parse("0xCAFEBABE0123456789ABCDEF00000001");

dstns::ScenarioConfig grid_config(std::size_t grid) {
    dstns::ScenarioConfig cfg;
    cfg.grid_width = static_cast<std::uint32_t>(grid);
    cfg.grid_height = static_cast<std::uint32_t>(grid);
    cfg.max_nodes = std::max<std::uint32_t>(cfg.max_nodes, static_cast<std::uint32_t>(grid * grid));
    return cfg;
}

/// An engine on a private log directory, removed afterwards.
struct Bench {
    std::filesystem::path dir;
    std::unique_ptr<dstns::RuntimeLogger> logger;
    std::unique_ptr<dstns::SimulationEngine> engine;
    explicit Bench(const std::string& label) {
        dir = std::filesystem::temp_directory_path() / ("dstns-bench-" + label + "-" + std::to_string(::getpid()));
        std::filesystem::remove_all(dir);
        logger = std::make_unique<dstns::RuntimeLogger>(dir);
        engine = std::make_unique<dstns::SimulationEngine>(*logger);
    }
    ~Bench() {
        engine->terminate();
        engine.reset();
        logger.reset();
        std::error_code ignored;
        std::filesystem::remove_all(dir, ignored);
    }
};

/// Microseconds per physics tick over `seconds` of virtual time.
double tick_cost_us(dstns::SimulationEngine& engine, std::uint32_t seconds) {
    const auto start = Clock::now();
    for (std::uint32_t done = 0; done < seconds; done += 3600) engine.step(std::min<std::uint32_t>(3600, seconds - done));
    return ms_since(start) * 1000.0 / seconds;
}

// ---------------------------------------------------------------------------
// network: how cost grows with the district
// ---------------------------------------------------------------------------

json network_suite(const std::vector<std::size_t>& grids, bool quick) {
    json out = json::array();
    std::vector<std::vector<std::string>> table{{"grid", "nodes", "edges", "compile", "tick", "ticks/s", "x real time*",
                                                 "seek", "snapshot", "snap JSON", "snap size", "topology", "topo cached", "topo size", "A* route"}};
    for (const auto grid : grids) {
        auto cfg = grid_config(grid);
        dstns::ScenarioCompiler compiler;
        auto start = Clock::now();
        auto scenario = compiler.compile(kSeed, cfg);
        const double compile_ms = ms_since(start);

        dstns::GraphStore store(scenario);
        dstns::RoutePlanner planner(store);
        const auto n = static_cast<std::uint32_t>(scenario.nodes.size());
        start = Clock::now();
        std::size_t routes = 0;
        for (std::uint32_t i = 0; i < 200; ++i) {
            (void)planner.route(dstns::NodeId{(i * 7919u) % n}, dstns::NodeId{(i * 104729u + n / 2) % n});
            ++routes;
        }
        const double route_us = ms_since(start) * 1000.0 / double(routes);

        Bench bench("network-" + std::to_string(grid));
        auto& engine = *bench.engine;
        engine.prepare(kSeed, cfg);
        engine.seek(6 * 3600, false);  // into the morning, so demand and weather are live
        const double tick_us = tick_cost_us(engine, quick ? 1800 : 3600);

        // Seeking back replays from the nearest quarter-hour checkpoint.
        std::vector<double> seeks;
        for (const std::uint32_t target : {3 * 3600 + 450u, 5 * 3600 + 120u, 1 * 3600 + 899u, 4 * 3600 + 600u}) {
            start = Clock::now();
            engine.seek(target, false);
            seeks.push_back(ms_since(start));
            engine.seek(7 * 3600, false);
        }

        std::vector<double> build, serialize;
        std::size_t snapshot_bytes = 0;
        for (int i = 0; i < (quick ? 5 : 15); ++i) {
            start = Clock::now();
            auto snap = engine.snapshot();
            build.push_back(ms_since(start));
            start = Clock::now();
            snapshot_bytes = dstns::dump_json(snap).size();
            serialize.push_back(ms_since(start));
        }

        start = Clock::now();
        const auto topo_bytes = dstns::dump_json(engine.topology()).size();
        const double topo_ms = ms_since(start);
        (void)engine.topology_text();  // fill the cache
        std::vector<double> cached;
        for (int i = 0; i < 10; ++i) {
            start = Clock::now();
            (void)engine.topology_text();
            cached.push_back(ms_since(start));
        }

        const double ticks_per_s = 1e6 / tick_us;
        // The fastest playback compresses a day into 60 s: 1440 virtual seconds
        // per second. The default one-hour day needs 24.
        const double headroom = ticks_per_s / 1440.0;
        out.push_back({{"grid", grid}, {"nodes", scenario.nodes.size()}, {"edges", scenario.edges.size()},
                       {"compile_ms", compile_ms}, {"tick_us", tick_us}, {"ticks_per_s", ticks_per_s},
                       {"fastest_playback_headroom", headroom}, {"seek_ms_p50", quantile(seeks, 0.5)},
                       {"snapshot_build_ms_p50", quantile(build, 0.5)}, {"snapshot_serialize_ms_p50", quantile(serialize, 0.5)},
                       {"snapshot_bytes", snapshot_bytes}, {"topology_uncached_ms", topo_ms},
                       {"topology_cached_ms_p50", quantile(cached, 0.5)}, {"topology_bytes", topo_bytes}, {"route_us", route_us}});
        table.push_back({std::to_string(grid) + "x" + std::to_string(grid), std::to_string(scenario.nodes.size()),
                         std::to_string(scenario.edges.size()), fixed(compile_ms, 0) + " ms", fixed(tick_us, 0) + " us",
                         fixed(ticks_per_s, 0), fixed(headroom, 1) + "x", fixed(quantile(seeks, 0.5), 1) + " ms",
                         fixed(quantile(build, 0.5), 1) + " ms", fixed(quantile(serialize, 0.5), 1) + " ms", mib(snapshot_bytes),
                         fixed(topo_ms, 1) + " ms", fixed(quantile(cached, 0.5), 2) + " ms", mib(topo_bytes), fixed(route_us, 1) + " us"});
    }
    print_table("Network size", table);
    std::cout << "  * ticks per second over the 1440 the fastest playback (a 60-second day) needs; below 1x that speed falls behind.\n"
                 "    The default one-hour day needs 24, so divide by 24 instead for its headroom.\n";
    return out;
}

// ---------------------------------------------------------------------------
// events: how cost grows with weather and incidents
// ---------------------------------------------------------------------------

json events_suite(std::size_t grid, bool quick) {
    json out = json::array();
    std::vector<std::vector<std::string>> table{{"storms/day", "incidents/day", "tick", "ticks/s", "news items"}};
    const std::vector<std::pair<std::uint32_t, std::uint32_t>> loads =
        quick ? std::vector<std::pair<std::uint32_t, std::uint32_t>>{{0, 4}, {12, 32}, {48, 128}}
              : std::vector<std::pair<std::uint32_t, std::uint32_t>>{{0, 4}, {3, 4}, {12, 16}, {24, 64}, {48, 128}, {96, 256}};
    for (const auto& [storms, incidents] : loads) {
        auto cfg = grid_config(grid);
        cfg.playback_duration_s = 1200;  // storms must start five playback seconds apart
        cfg.dws_frequency = storms;
        cfg.min_incidents = incidents;
        Bench bench("events");
        auto& engine = *bench.engine;
        engine.prepare(kSeed, cfg);
        engine.seek(8 * 3600, false);
        const double tick_us = tick_cost_us(engine, quick ? 3600 : 4 * 3600);
        const auto news = engine.news(0, 100000)["data"]["items"].size();
        out.push_back({{"grid", grid}, {"storms_per_day", storms}, {"incidents_per_day", incidents},
                       {"tick_us", tick_us}, {"ticks_per_s", 1e6 / tick_us}, {"news_items", news}});
        table.push_back({std::to_string(storms), std::to_string(incidents), fixed(tick_us, 0) + " us", fixed(1e6 / tick_us, 0),
                         std::to_string(news)});
    }
    print_table("Event load (" + std::to_string(grid) + "x" + std::to_string(grid) + " grid, 08:00 onwards)", table);
    return out;
}

// ---------------------------------------------------------------------------
// observers: clients polling while the clock runs
// ---------------------------------------------------------------------------

// The engine runs real playback - its own wall-clock loop, as in the server -
// at the fastest speed it offers, a day in 60 seconds (1440 virtual seconds a
// second; the default one-hour day needs 24).
// Observers fetch and serialize a snapshot the way the browser does, once a
// second; the last rows poll continuously, a stress far beyond any real
// audience. The questions: does the clock keep up, and how long does an
// observer wait for its picture?
json observers_suite(std::size_t grid, bool quick) {
    json out = json::array();
    std::vector<std::vector<std::string>> table{{"observers", "polling", "virtual s/s", "keeps up", "snapshot p50", "snapshot p95", "snapshots/s"}};
    struct Load { int observers; bool continuous; };
    const std::vector<Load> loads{{0, false}, {1, false}, {8, false}, {32, false}, {2, true}, {8, true}};
    for (const auto& load : loads) {
        Bench bench("observers");
        auto& engine = *bench.engine;
        auto cfg = grid_config(grid);
        cfg.playback_duration_s = 60;
        engine.start(kSeed, cfg, 7 * 3600);
        std::atomic<bool> done{false};
        std::vector<std::vector<double>> latencies(load.observers);
        std::vector<std::thread> threads;
        for (int r = 0; r < load.observers; ++r) {
            threads.emplace_back([&, r] {
                // Spread the once-a-second observers across the second.
                auto next = Clock::now() + std::chrono::milliseconds(1000 * r / std::max(1, load.observers));
                while (!done.load()) {
                    if (!load.continuous) {
                        std::this_thread::sleep_until(next);
                        next += std::chrono::seconds(1);
                        if (done.load()) break;
                    }
                    const auto start = Clock::now();
                    const auto body = dstns::dump_json(engine.snapshot());  // what the API sends
                    latencies[r].push_back(ms_since(start));
                    (void)body;
                }
            });
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        auto clock = [&] { return engine.status()["data"]["simulated_seconds"].get<double>(); };
        const double v0 = clock();
        const auto start = Clock::now();
        std::this_thread::sleep_for(std::chrono::seconds(quick ? 4 : 8));
        const double v1 = clock();
        const double wall = ms_since(start) / 1000.0;
        done = true;
        for (auto& t : threads) t.join();
        std::vector<double> all;
        for (const auto& l : latencies) all.insert(all.end(), l.begin(), l.end());
        const double rate = (v1 - v0) / wall;
        const char* polling = load.observers == 0 ? "-" : load.continuous ? "continuous" : "1 Hz";
        out.push_back({{"grid", grid}, {"observers", load.observers}, {"polling", polling},
                       {"virtual_seconds_per_s", rate}, {"target_virtual_seconds_per_s", 1440}, {"keeps_up", rate / 1440.0},
                       {"snapshot_ms_p50", quantile(all, 0.5)}, {"snapshot_ms_p95", quantile(all, 0.95)},
                       {"snapshots_per_s", double(all.size()) / wall}});
        table.push_back({std::to_string(load.observers), polling, fixed(rate, 0), fixed(100.0 * rate / 1440.0, 0) + "%",
                         load.observers ? fixed(quantile(all, 0.5), 1) + " ms" : "-",
                         load.observers ? fixed(quantile(all, 0.95), 1) + " ms" : "-",
                         load.observers ? fixed(double(all.size()) / wall, 1) : "-"});
    }
    print_table("Concurrent observers (" + std::to_string(grid) + "x" + std::to_string(grid) + " grid, fastest playback: 1440 virtual s/s)", table);
    return out;
}

// ---------------------------------------------------------------------------
// narrator: queue, cache and (optionally) a real model
// ---------------------------------------------------------------------------

/// Answers instantly, or after a fixed delay, with text that passes the checks.
class FixedBackend final : public dstns::NarrationBackend {
public:
    explicit FixedBackend(std::chrono::milliseconds delay) : delay_(delay) {}
    bool ready() override { return true; }
    std::optional<std::string> complete(const std::string&, const std::string&) override {
        if (delay_.count()) std::this_thread::sleep_for(delay_);
        return std::string("Traffic conditions have changed on the network.");
    }
    [[nodiscard]] json describe() const override { return {{"kind", "fixed"}, {"model", "fixed"}}; }
private:
    std::chrono::milliseconds delay_;
};

std::vector<dstns::NarrationRequest> world_requests(const dstns::Scenario& scenario, const dstns::NarrationContext& context) {
    std::vector<dstns::NarrationRequest> requests;
    for (const auto& inc : scenario.incidents) {
        const nlohmann::json data{{"incident_id", inc.id}, {"type", dstns::to_string(inc.type)}, {"edge_id", inc.edge.value},
                                  {"node_id", inc.node.value}, {"speed_multiplier", inc.speed_multiplier},
                                  {"capacity_multiplier", inc.capacity_multiplier}, {"closed", inc.closed},
                                  {"end_virtual_s", inc.end_virtual_s}};
        if (auto r = dstns::narration_request(context, "INCIDENT_ACTIVATED", "[00:00:00] " + inc.description + " on Edge #0", data, inc.start_virtual_s))
            requests.push_back(*r);
        if (auto r = dstns::narration_request(context, "INCIDENT_RESOLVED", "", data, inc.end_virtual_s)) requests.push_back(*r);
    }
    for (const auto& e : scenario.dws_events) {
        const nlohmann::json data{{"epicenter", e.epicenter.value}, {"radius_m", e.radius_m}, {"intensity", e.intensity}};
        for (const char* t : {"DWS_RAIN_STARTED", "DWS_RAIN_PEAK", "DWS_RAIN_ENDED"})
            if (auto r = dstns::narration_request(context, t, "", data, 0)) requests.push_back(*r);
    }
    return requests;
}

json narrator_suite(const std::string& live_endpoint, bool quick) {
    json out;
    auto cfg = grid_config(25);
    cfg.min_incidents = 24;
    cfg.dws_frequency = 8;
    dstns::ScenarioCompiler compiler;
    const auto scenario = compiler.compile(kSeed, cfg);
    const dstns::NarrationContext context(scenario);
    const auto requests = world_requests(scenario, context);

    // The cost the simulation thread pays: building facts and queueing them.
    {
        dstns::Narrator narrator(std::make_unique<FixedBackend>(std::chrono::milliseconds(0)), {});
        const auto& inc = scenario.incidents.front();
        const nlohmann::json data{{"incident_id", inc.id}, {"type", dstns::to_string(inc.type)}, {"edge_id", inc.edge.value},
                                  {"node_id", inc.node.value}, {"speed_multiplier", inc.speed_multiplier},
                                  {"capacity_multiplier", inc.capacity_multiplier}, {"closed", inc.closed}, {"end_virtual_s", inc.end_virtual_s}};
        const int n = 20000;
        auto start = Clock::now();
        for (int i = 0; i < n; ++i) (void)dstns::narration_request(context, "INCIDENT_ACTIVATED", inc.description, data, 0);
        const double facts_us = ms_since(start) * 1000.0 / n;
        for (const auto& r : requests) narrator.request(r, false);
        narrator.wait_idle(std::chrono::seconds(10));
        start = Clock::now();
        for (int i = 0; i < n; ++i) narrator.request(requests[std::size_t(i) % requests.size()], true);
        const double hit_us = ms_since(start) * 1000.0 / n;
        start = Clock::now();
        for (int i = 0; i < n; ++i) (void)narrator.lookup(requests[std::size_t(i) % requests.size()].key);
        const double lookup_us = ms_since(start) * 1000.0 / n;
        out["hot_path"] = {{"facts_us", facts_us}, {"request_cache_hit_us", hit_us}, {"lookup_us", lookup_us}};
        print_table("Narrator: cost on the simulation thread", {{"operation", "per call"},
                    {"build facts for an incident", fixed(facts_us, 2) + " us"},
                    {"request (already narrated)", fixed(hit_us, 2) + " us"},
                    {"lookup for the news feed", fixed(lookup_us, 2) + " us"}});
    }

    // Queue throughput against a model with a fixed latency, cold then warm.
    {
        std::vector<std::vector<std::string>> table{{"model latency", "workers", "requests", "cold", "per item", "warm (cached)"}};
        json rows = json::array();
        for (const int delay : quick ? std::vector<int>{50} : std::vector<int>{0, 50, 250}) {
            for (const unsigned workers : {1u, 2u, 4u}) {
                const auto cache = std::filesystem::temp_directory_path() / ("dstns-bench-narrations-" + std::to_string(::getpid()) + ".db");
                std::filesystem::remove(cache);
                double cold = 0, warm = 0;
                {
                    dstns::Narrator narrator(std::make_unique<FixedBackend>(std::chrono::milliseconds(delay)), {cache, 4096, 1024, workers});
                    const auto start = Clock::now();
                    for (const auto& r : requests) narrator.request(r, false);
                    narrator.wait_idle(std::chrono::minutes(2));
                    cold = ms_since(start);
                }
                {
                    // A restart: the persistent cache answers everything.
                    dstns::Narrator narrator(std::make_unique<FixedBackend>(std::chrono::milliseconds(delay)), {cache, 4096, 1024, workers});
                    const auto start = Clock::now();
                    for (const auto& r : requests) narrator.request(r, false);
                    narrator.wait_idle(std::chrono::minutes(2));
                    warm = ms_since(start);
                }
                std::filesystem::remove(cache);
                rows.push_back({{"model_latency_ms", delay}, {"workers", workers}, {"requests", requests.size()},
                                {"cold_ms", cold}, {"warm_ms", warm}});
                table.push_back({std::to_string(delay) + " ms", std::to_string(workers), std::to_string(requests.size()),
                                 fixed(cold, 0) + " ms", fixed(cold / double(requests.size()), 1) + " ms", fixed(warm, 2) + " ms"});
            }
        }
        out["queue"] = rows;
        print_table("Narrator: one world's incidents and storms (" + std::to_string(requests.size()) + " items)", table);
    }

    if (live_endpoint.empty()) return out;

    // A real model, end to end.
    std::unique_ptr<dstns::NarrationBackend> backend;
    if (live_endpoint == "fm") {
        const auto fm = dstns::find_fm();
        if (!fm) { std::cout << "\n  --narrator fm: the fm command was not found; skipping the live model.\n"; return out; }
        backend = dstns::make_fm_backend(*fm);
    } else {
        backend = dstns::make_chat_backend(live_endpoint, "system");
    }
    const auto description = backend->describe();
    std::vector<dstns::NarrationRequest> sample(requests.begin(), requests.begin() + std::min<std::size_t>(requests.size(), quick ? 8 : 24));
    const auto cache = std::filesystem::temp_directory_path() / ("dstns-bench-live-" + std::to_string(::getpid()) + ".db");
    std::filesystem::remove(cache);
    dstns::Narrator narrator(std::move(backend), {cache, 4096, 1024, 2});
    const auto start = Clock::now();
    for (const auto& r : sample) narrator.request(r, false);
    narrator.wait_idle(std::chrono::minutes(10));
    const double total = ms_since(start);
    const auto status = narrator.status();
    std::vector<std::vector<std::string>> table{{"facts", "narration"}};
    json examples = json::array();
    std::set<std::string> shown;
    for (const auto& r : sample) {
        if (shown.contains(r.template_id) || shown.size() >= 4) continue;
        const auto told = narrator.lookup(r.key);
        if (!told) continue;
        shown.insert(r.template_id);
        auto facts = r.facts;
        std::replace(facts.begin(), facts.end(), '\n', ';');
        examples.push_back({{"template_id", r.template_id}, {"facts", r.facts}, {"narration", told->text}});
        std::cout << "\n  " << r.template_id << "\n    facts:     " << facts << "\n    narration: " << told->text << "\n";
    }
    std::filesystem::remove(cache);
    out["live"] = {{"backend", description}, {"requests", sample.size()}, {"total_ms", total},
                   {"accepted", status["completed"]}, {"refused", status["refused"]}, {"failed", status["failed"]},
                   {"latency_ms_mean", status["latency_ms"]["mean"]}, {"latency_ms_max", status["latency_ms"]["max"]},
                   {"examples", examples}};
    print_table("Narrator: live model (" + description.value("kind", std::string("model")) + ")",
                {{"requests", "accepted", "refused", "failed", "mean latency", "max latency", "wall time"},
                 {std::to_string(sample.size()), status["completed"].dump(), status["refused"].dump(), status["failed"].dump(),
                  fixed(status["latency_ms"]["mean"].get<double>(), 0) + " ms", fixed(status["latency_ms"]["max"].get<double>(), 0) + " ms",
                  fixed(total / 1000.0, 1) + " s"}});
    return out;
}

} // namespace

int main(int argc, char** argv) {
    try {
        bool quick = false;
        std::string json_path, narrator, suites = "network,events,observers,narrator";
        std::vector<std::size_t> grids;
        for (int i = 1; i < argc; ++i) {
            const std::string a = argv[i];
            if (a == "--quick") quick = true;
            else if (a == "--json" && i + 1 < argc) json_path = argv[++i];
            else if (a == "--narrator" && i + 1 < argc) narrator = argv[++i];
            else if (a == "--suite" && i + 1 < argc) suites = argv[++i];
            else if (a == "--help") {
                std::cout << "dstns_benchmark [--quick] [--json FILE] [--narrator fm|http://HOST:PORT|unix:/PATH]\n"
                             "                [--suite network,events,observers,narrator] [GRID ...]\n";
                return 0;
            } else if (!a.empty() && std::isdigit(static_cast<unsigned char>(a[0]))) {
                grids.push_back(std::stoul(a));
            } else {
                throw std::invalid_argument("unknown argument: " + a);
            }
        }
        if (grids.empty()) grids = quick ? std::vector<std::size_t>{10, 25, 50} : std::vector<std::size_t>{10, 25, 50, 75, 100};
        auto wants = [&](const char* s) { return ("," + suites + ",").find(std::string(",") + s + ",") != std::string::npos; };

        dstns::set_thread_role(dstns::ThreadRole::Simulation);
        const auto processor = dstns::processor_description();
        std::cout << "DSTNS " << DSTNS_VERSION << " benchmark on " << processor << (quick ? " (quick)" : "") << "\n";

        json report{{"version", DSTNS_VERSION}, {"revision", DSTNS_REVISION}, {"processor", processor},
                    {"architecture", DSTNS_BUILD_ARCH}, {"hardware_threads", std::thread::hardware_concurrency()},
                    {"quick", quick},
                    {"timestamp", std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count()}};
        if (wants("network")) report["network"] = network_suite(grids, quick);
        if (wants("events")) report["events"] = events_suite(50, quick);
        if (wants("observers")) report["observers"] = observers_suite(50, quick);
        if (wants("narrator")) report["narrator"] = narrator_suite(narrator, quick);

        if (!json_path.empty()) {
            std::ofstream out(json_path);
            out << dstns::dump_json(report, 2) << "\n";
            std::cout << "\nWrote " << json_path << "\n";
        }
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "benchmark failed: " << e.what() << "\n";
        return 1;
    }
}
