// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// dstns_benchmark compute: the physics step on each backend, by world size.
//
// Every figure is measured on this machine, in this run. Worlds are synthetic
// grids (dstns/compute/synthetic.hpp) so that sizes beyond a compiled
// scenario's 50,000-node limit can be measured; each step is driven with
// inputs like the engine's: every signal phase, a tenth of the edges' demand
// couplings, active storms and a surge.

#include "dstns/compute/dispatcher.hpp"
#include "dstns/compute/synthetic.hpp"
#include "dstns/compute/vulkan.hpp"
#include "dstns/engine.hpp"
#include "dstns/logging.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {
using namespace dstns;
using namespace dstns::compute;
using Clock = std::chrono::steady_clock;

double since(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

double median(std::vector<double> v) {
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
}

struct Measured {
    bool ran{};
    std::string error;
    double install_ms{}, step_ms{}, hundred_ms{}, replay_ms{}, view_ms{}, readback_ms{};
    double device_ms{};
    std::uint64_t upload_per_step{}, readback_per_step{};
    std::uint32_t replay_steps{};
};

StepRequest drive(ComputeDispatcher& d, std::uint32_t t) {
    const auto& tables = d.tables();
    for (std::uint32_t i = 0; i < tables.signal_count; ++i) d.set_signal_phase(i, (t / 30 + i) % 6);
    for (std::uint32_t e = t % 10; e < tables.edge_count; e += 10) d.set_attraction(e, 0.25 * std::sin(0.001 * (t + e)));
    StepRequest r;
    r.virtual_s = 30'000 + t;
    r.day_profile = 0.7;
    const double extent = std::sqrt(double(tables.node_count)) * 120.0;
    for (int k = 0; k < 3; ++k) r.storms.push_back({extent * (0.2 + 0.3 * k), extent * 0.5, 600.0 + 100 * k, 0.8});
    if (tables.node_count) r.surges.push_back({tables.node_count / 2, 2.0, 500});
    return r;
}

Measured measure(const Scenario& world, ComputeOptions options, std::uint32_t replay_steps) {
    Measured m;
    try {
        ComputeDispatcher d(options, {});
        auto started = Clock::now();
        d.install(world);
        m.install_ms = since(started);
        const bool want_vulkan = options.backend == BackendPreference::Vulkan;
        if (want_vulkan && d.active() != BackendType::Vulkan) {
            m.error = d.describe()["selection_reason"].get<std::string>();
            return m;
        }
        std::uint32_t t = 0;
        for (int i = 0; i < 3; ++i) (void)d.step(drive(d, ++t)); // warm
        std::vector<double> steps;
        for (int i = 0; i < 15; ++i) {
            const auto request = drive(d, ++t);
            started = Clock::now();
            (void)d.step(request);
            steps.push_back(since(started));
        }
        m.step_ms = median(steps);
        const auto described = d.describe()["step"];
        m.device_ms = described.value("gpu_ms", 0.0);
        m.upload_per_step = described.value("upload_bytes", 0ull);
        m.readback_per_step = described.value("readback_bytes", 0ull);

        started = Clock::now();
        for (int i = 0; i < 100; ++i) (void)d.step(drive(d, ++t));
        m.hundred_ms = since(started);

        // A seek: restore a checkpoint, replay, and read the result back.
        const auto checkpoint = d.export_state();
        started = Clock::now();
        d.import_state(checkpoint);
        for (std::uint32_t i = 0; i < replay_steps; ++i) (void)d.step(drive(d, ++t));
        (void)d.export_state();
        m.replay_ms = since(started);
        m.replay_steps = replay_steps;

        // What an observer snapshot costs: the double-precision view of every
        // node and edge, after one more step so it must be fetched afresh.
        (void)d.step(drive(d, ++t));
        std::vector<NodeDynamic> nodes;
        std::vector<EdgeDynamic> edges;
        started = Clock::now();
        d.materialize(nodes, edges, 1);
        m.view_ms = since(started);

        (void)d.step(drive(d, ++t));
        started = Clock::now();
        (void)d.export_state();
        m.readback_ms = since(started);
        m.ran = true;
    } catch (const std::exception& e) {
        m.error = e.what();
    }
    return m;
}

std::string fmt(double v, int precision = 2) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(precision) << v;
    return out.str();
}

std::string bytes(std::uint64_t b) {
    if (b >= (1ull << 20)) return fmt(double(b) / double(1ull << 20), 1) + " MiB";
    if (b >= 1024) return fmt(double(b) / 1024.0, 1) + " KiB";
    return std::to_string(b) + " B";
}

nlohmann::json json_of(const Measured& m) {
    if (!m.ran) return {{"ran", false}, {"error", m.error}};
    return {{"ran", true}, {"install_ms", m.install_ms}, {"step_ms", m.step_ms}, {"device_ms", m.device_ms},
            {"hundred_steps_ms", m.hundred_ms}, {"replay_ms", m.replay_ms}, {"replay_steps", m.replay_steps},
            {"snapshot_view_ms", m.view_ms}, {"full_readback_ms", m.readback_ms},
            {"upload_bytes_per_step", m.upload_per_step}, {"readback_bytes_per_step", m.readback_per_step}};
}

} // namespace

int compute_benchmark(int argc, char** argv) {
    std::vector<std::uint32_t> sizes{1'000, 3'000, 10'000, 50'000, 100'000, 500'000, 1'000'000};
    std::string json_path, device = "auto";
    std::uint32_t replay_steps = 900;
    bool day = false;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--sizes" && i + 1 < argc) {
            sizes.clear();
            std::stringstream list(argv[++i]);
            for (std::string item; std::getline(list, item, ',');) sizes.push_back(static_cast<std::uint32_t>(std::stoul(item)));
        } else if (a == "--json" && i + 1 < argc) json_path = argv[++i];
        else if (a == "--device" && i + 1 < argc) device = argv[++i];
        else if (a == "--replay-steps" && i + 1 < argc) replay_steps = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        else if (a == "--day") day = true;
        else {
            std::cout << "dstns_benchmark compute [--sizes N,N,...] [--device auto|INDEX|NAME] [--replay-steps N] [--day] [--json FILE]\n";
            return a == "--help" ? 0 : 2;
        }
    }

    ComputeOptions cpu1;
    cpu1.backend = BackendPreference::Cpu;
    cpu1.cpu_threads = 1;
    ComputeOptions cpun = cpu1;
    cpun.cpu_threads = 0;
    ComputeOptions gpu;
    gpu.backend = BackendPreference::Vulkan;
    gpu.device = device;
    gpu.calibrate = false;
    gpu.allow_software_vulkan = device != "auto";
    const auto threads = std::clamp(std::thread::hardware_concurrency(), 1u, 8u);

    // Bring-up of the accelerator itself, with an empty and a filled pipeline cache.
    nlohmann::json report{{"tool", "dstns_benchmark compute"}, {"cpu_threads", threads}};
    const auto cache = std::filesystem::temp_directory_path() / "dstns-benchmark-cache";
    std::filesystem::remove_all(cache);
    std::optional<ComputeCapabilities> caps;
    double cold_ms = 0, warm_ms = 0;
    {
        auto o = gpu;
        o.cache_dir = cache.string();
        std::string reason;
        auto started = Clock::now();
        auto first = create_vulkan_backend(o, {}, reason);
        cold_ms = since(started);
        if (first) {
            caps = first->capabilities();
            first.reset();
            started = Clock::now();
            auto second = create_vulkan_backend(o, {}, reason);
            warm_ms = since(started);
        } else {
            std::cout << "Vulkan unavailable: " << reason << "\n";
        }
    }
    std::filesystem::remove_all(cache);

    std::cout << "DSTNS Compute Benchmark\n\n";
    if (caps) {
        std::cout << "Device      " << caps->name << " (" << caps->device_type << ")\n"
                  << "Driver      " << caps->driver << " " << caps->driver_version << (caps->moltenvk ? "  [Vulkan via MoltenVK -> Metal]" : "") << "\n"
                  << "Vulkan      " << caps->api_version << ", workgroup " << caps->workgroup_size << ", timestamps " << (caps->timestamps ? "yes" : "no") << "\n"
                  << "Bring-up    " << fmt(cold_ms, 0) << " ms with a cold pipeline cache, " << fmt(warm_ms, 0) << " ms warm (instance, device, pipelines, self-test)\n";
        report["device"] = {{"name", caps->name}, {"type", caps->device_type}, {"driver", caps->driver}, {"driver_version", caps->driver_version},
                            {"api_version", caps->api_version}, {"moltenvk", caps->moltenvk}, {"workgroup_size", caps->workgroup_size},
                            {"bring_up_cold_ms", cold_ms}, {"bring_up_warm_ms", warm_ms}};
    }
    std::cout << "CPU         " << threads << " threads available\n\n";

    report["sizes"] = nlohmann::json::array();
    std::optional<std::uint32_t> break_even_nodes, break_even_edges;
    for (const auto n : sizes) {
        const auto world = synthetic_world(n, 7);
        const auto tables = build_static_tables(world);
        std::cout << "World " << world.nodes.size() << " nodes, " << world.edges.size() << " directed edges, " << world.signals.size()
                  << " signals; state " << bytes(tables.state_words() * 4) << "\n";
        const auto a = measure(world, cpu1, replay_steps);
        const auto b = measure(world, cpun, replay_steps);
        const auto c = caps ? measure(world, gpu, replay_steps) : Measured{false, "Vulkan unavailable"};
        auto row = [&](const char* name, const Measured& m) {
            if (!m.ran) {
                std::cout << "  " << std::left << std::setw(13) << name << "not run: " << m.error << "\n";
                return;
            }
            std::cout << "  " << std::left << std::setw(13) << name << "step " << std::setw(9) << (fmt(m.step_ms, 3) + " ms")
                      << " 100 steps " << std::setw(10) << (fmt(m.hundred_ms, 1) + " ms")
                      << " seek(" << m.replay_steps << ") " << std::setw(10) << (fmt(m.replay_ms, 1) + " ms")
                      << " install " << std::setw(9) << (fmt(m.install_ms, 1) + " ms")
                      << " view " << fmt(m.view_ms, 2) << " ms";
            if (m.device_ms > 0) std::cout << "  [GPU " << fmt(m.device_ms, 3) << " ms]";
            std::cout << "\n";
        };
        row("CPU 1 thread", a);
        row(("CPU " + std::to_string(threads) + " threads").c_str(), b);
        row("Vulkan", c);
        const auto best_cpu = (b.ran && b.step_ms < a.step_ms) ? b.step_ms : a.step_ms;
        if (c.ran) {
            std::cout << "  per step: upload " << bytes(c.upload_per_step) << ", readback " << bytes(c.readback_per_step)
                      << "; full readback " << fmt(c.readback_ms, 2) << " ms\n";
            const auto speedup = best_cpu / c.step_ms;
            std::cout << "  speedup " << fmt(speedup, 2) << "x over the faster CPU configuration\n";
            if (speedup > 1.0 / 0.9 && !break_even_nodes) {
                break_even_nodes = static_cast<std::uint32_t>(world.nodes.size());
                break_even_edges = static_cast<std::uint32_t>(world.edges.size());
            }
        }
        std::cout << "\n";
        report["sizes"].push_back({{"nodes", world.nodes.size()}, {"edges", world.edges.size()}, {"state_bytes", tables.state_words() * 4},
                                   {"cpu_1_thread", json_of(a)}, {"cpu_threads", json_of(b)}, {"vulkan", json_of(c)}});
    }
    if (break_even_nodes)
        std::cout << "Break-even: Vulkan is at least 10% faster from about " << *break_even_nodes << " nodes (" << *break_even_edges << " edges) on this machine.\n";
    else if (caps)
        std::cout << "Break-even: Vulkan was not 10% faster at any measured size on this machine.\n";
    report["break_even"] = break_even_nodes ? nlohmann::json{{"nodes", *break_even_nodes}, {"edges", *break_even_edges}} : nlohmann::json(nullptr);

    if (day) {
        // A full simulated day through the whole engine, on a district-sized
        // compiled world, as the operator would run it.
        ScenarioConfig config;
        config.grid_width = 55;
        config.grid_height = 55;
        config.playback_duration_s = 600;
        nlohmann::json days = nlohmann::json::object();
        for (const auto& [label, o] : {std::pair{"cpu", cpun}, std::pair{"vulkan", gpu}}) {
            if (std::string(label) == "vulkan" && !caps) continue;
            const auto dir = std::filesystem::temp_directory_path() / "dstns-benchmark-day";
            std::filesystem::remove_all(dir);
            RuntimeLogger logger(dir);
            SimulationEngine engine(logger, o);
            engine.prepare(Seed128::parse("0xCAFEBABE0123456789ABCDEF00000001"), config);
            const auto started = Clock::now();
            (void)engine.seek(86'400, false);
            const auto ms = since(started);
            std::cout << "Full day, 55x55 compiled world, engine on " << label << ": " << fmt(ms / 1000.0, 1) << " s ("
                      << fmt(ms / 86.4, 1) << " us per simulated second)\n";
            days[label] = ms;
            engine.terminate();
        }
        report["full_day_ms"] = days;
    }
    if (!json_path.empty()) {
        std::ofstream(json_path) << report.dump(2) << "\n";
        std::cout << "Report written to " << json_path << "\n";
    }
    return 0;
}
