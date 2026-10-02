// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The whole simulator under each backend: events, news, demand couplings,
// checkpoints and operator controls on top of the physics step. A run on
// Vulkan must be indistinguishable from the same run on the CPU, through
// seeks, world replacement, reset, and a device lost mid-run.
//
// Exit 77 (skipped) when no Vulkan device is available.

#include "dstns/compute/vulkan.hpp"
#include "dstns/engine.hpp"
#include "dstns/logging.hpp"

#include <filesystem>
#include <iostream>
#include <memory>
#include <string>

namespace {
using namespace dstns;

int failures = 0, checks = 0;

void check(bool condition, const std::string& what) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << what << "\n";
    } else {
        std::cout << "  ok  " << what << "\n";
    }
}

compute::ComputeOptions options(compute::BackendPreference backend) {
    compute::ComputeOptions o;
    o.backend = backend;
    o.allow_software_vulkan = true;
    o.calibrate = false;
    o.cache_dir.clear();
    o.cpu_threads = 1;
    return o;
}

struct Run {
    std::filesystem::path directory;
    std::unique_ptr<RuntimeLogger> logger;
    std::unique_ptr<SimulationEngine> engine;
    Run(const std::string& label, compute::ComputeOptions o) {
        directory = std::filesystem::temp_directory_path() / ("dstns-engine-compute-" + label);
        std::filesystem::remove_all(directory);
        logger = std::make_unique<RuntimeLogger>(directory);
        engine = std::make_unique<SimulationEngine>(*logger, o);
    }
    ~Run() {
        engine->terminate();
        engine.reset();
        logger.reset();
        std::filesystem::remove_all(directory);
    }
    [[nodiscard]] std::string backend() const { return engine->compute_status()["active_backend"].get<std::string>(); }
};

ScenarioConfig grid() {
    ScenarioConfig c;
    c.grid_width = 16;
    c.grid_height = 14;
    c.dws_frequency = 6;
    c.playback_duration_s = 600;
    return c;
}

const auto kSeed = Seed128::parse("0xFEEDFACECAFED00D123456789ABCDEF0");

/// The observable state: every node and edge, the news, the congestion
/// index and the event history.
nlohmann::json observe(SimulationEngine& e) {
    return {{"snapshot", e.snapshot()["data"]}, {"news", e.news(0, 100000)["data"]}, {"history", e.history()["data"]},
            {"events", e.scheduled_events(false, "all", 0, 500)["data"]}};
}

/// Operator actions at fixed virtual times, applied identically to each run.
void act(SimulationEngine& e, std::uint32_t step) {
    switch (step) {
        case 1: (void)e.override_edge(EdgeId{5}, 0.4, 0.5, false); break;
        case 2: (void)e.toggle_signal(NodeId{20}); break;
        case 3: (void)e.trigger_surge(NodeId{100}, 3.0, 600, 3600); break;
        case 4: (void)e.add_weather(NodeId{60}, 0.9, 800, 90, 0.6); break;
        case 5: (void)e.override_edge(EdgeId{40}, 1.0, 1.0, true); break;
        case 6: (void)e.set_module("flooding", false); break;
        case 7: (void)e.set_module("flooding", true); break;
        case 8: (void)e.undo(2); break;
        case 9: (void)e.set_day(1); break;
        default: break;
    }
}

void same_run_on_both_backends() {
    Run cpu("cpu", options(compute::BackendPreference::Cpu));
    Run vk("vulkan", options(compute::BackendPreference::Vulkan));
    cpu.engine->prepare(kSeed, grid());
    vk.engine->prepare(kSeed, grid());
    check(vk.backend() == "vulkan", "the forced Vulkan engine runs the physics on Vulkan");
    bool equal = true;
    std::uint32_t t = 0;
    for (std::uint32_t step = 1; step <= 10 && equal; ++step) {
        t += 1'200;
        (void)cpu.engine->seek(t, false);
        (void)vk.engine->seek(t, false);
        act(*cpu.engine, step);
        act(*vk.engine, step);
        equal = observe(*cpu.engine) == observe(*vk.engine);
        if (!equal) check(false, "CPU and Vulkan diverged at virtual second " + std::to_string(t));
    }
    if (equal) check(true, "snapshots, news and events identical through 12,000 virtual seconds of operator actions");

    // Backward seeks restore a checkpoint and replay on the device.
    (void)cpu.engine->seek(4'444, false);
    (void)vk.engine->seek(4'444, false);
    check(observe(*cpu.engine) == observe(*vk.engine), "backward seek on Vulkan equals the same seek on the CPU");
    (void)vk.engine->seek(15'000, false);
    (void)cpu.engine->seek(15'000, false);
    check(observe(*cpu.engine) == observe(*vk.engine), "forward again after the backward seek");
    (void)vk.engine->step(37);
    (void)cpu.engine->step(37);
    check(cpu.engine->snapshot()["data"] == vk.engine->snapshot()["data"], "stepping");
    check(vk.backend() == "vulkan", "the run stayed on Vulkan throughout");
}

void seek_equals_continuous_on_vulkan() {
    Run a("continuous", options(compute::BackendPreference::Vulkan));
    Run b("seeking", options(compute::BackendPreference::Vulkan));
    a.engine->prepare(kSeed, grid());
    b.engine->prepare(kSeed, grid());
    (void)a.engine->seek(8'000, false);
    (void)b.engine->seek(16'000, false);
    (void)b.engine->seek(8'000, false); // back past nine checkpoints
    check(a.engine->snapshot()["data"] == b.engine->snapshot()["data"], "checkpoint restore + replay on Vulkan equals continuous execution");
}

void world_replacement_and_reset() {
    Run vk("replace", options(compute::BackendPreference::Vulkan));
    Run cpu("replace-cpu", options(compute::BackendPreference::Cpu));
    bool equal = true;
    for (std::uint64_t k = 0; k < 4 && equal; ++k) {
        auto config = grid();
        config.grid_width = 10 + 3 * static_cast<std::uint32_t>(k);
        const Seed128 seed{k + 1, 0xABCDEFull * (k + 3)};
        vk.engine->prepare(seed, config);
        cpu.engine->prepare(seed, config);
        (void)vk.engine->seek(2'500, false);
        (void)cpu.engine->seek(2'500, false);
        equal = vk.engine->snapshot()["data"] == cpu.engine->snapshot()["data"] && vk.backend() == "vulkan";
    }
    check(equal, "four successive worlds of different sizes on one Vulkan engine: no state carried over");
    (void)vk.engine->reset();
    (void)cpu.engine->reset();
    vk.engine->prepare(kSeed, grid());
    cpu.engine->prepare(kSeed, grid());
    (void)vk.engine->seek(3'000, false);
    (void)cpu.engine->seek(3'000, false);
    check(vk.engine->snapshot()["data"] == cpu.engine->snapshot()["data"], "after reset, a new run starts from clean device state");
}

void device_lost_mid_run() {
    auto o = options(compute::BackendPreference::Vulkan);
    o.fault = {compute::FaultInjection::Kind::DeviceLost, 1'500};
    Run faulty("lost", o);
    Run cpu("lost-cpu", options(compute::BackendPreference::Cpu));
    faulty.engine->prepare(kSeed, grid());
    cpu.engine->prepare(kSeed, grid());
    (void)faulty.engine->seek(1'000, false);
    (void)cpu.engine->seek(1'000, false);
    act(*faulty.engine, 5); // an operator closure between checkpoint and failure
    act(*cpu.engine, 5);
    (void)faulty.engine->seek(4'000, false); // the device is lost at step 1,500
    (void)cpu.engine->seek(4'000, false);
    const auto status = faulty.engine->compute_status();
    check(status["active_backend"] == "cpu" && status["health"]["vulkan"] == "failed", "a lost device moves the run to the CPU");
    check(observe(*faulty.engine) == observe(*cpu.engine), "the run continues exactly as a CPU-only run would");
}

void verification_mode() {
    auto o = options(compute::BackendPreference::Vulkan);
    o.verify = true;
    Run vk("verify", o);
    vk.engine->prepare(kSeed, grid());
    (void)vk.engine->seek(1'000, false);
    const auto totals = vk.engine->compute_status()["totals"];
    check(vk.backend() == "vulkan" && totals["verified_steps"].get<std::uint64_t>() >= 1'000 && totals["fallbacks"] == 0,
          "verification mode: 1,000 steps recomputed on the CPU, no mismatch");
}

} // namespace

int main() {
    std::cout << "[engine-compute] the simulator on the CPU and on Vulkan\n";
    compute::ComputeOptions probe;
    probe.allow_software_vulkan = true;
    probe.cache_dir.clear();
    const auto report = compute::vulkan_diagnostics(probe);
    bool usable = false;
    for (const auto& d : report["devices"]) usable = usable || (d.contains("self_test") && d["self_test"].value("passed", false));
    if (!usable) {
        std::cout << "SKIPPED: no usable Vulkan device\n";
        return 77;
    }
    same_run_on_both_backends();
    seek_equals_continuous_on_vulkan();
    world_replacement_and_reset();
    device_lost_mid_run();
    verification_mode();
    std::cout << "[engine-compute] " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
