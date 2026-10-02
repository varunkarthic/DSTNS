// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Structured-grid fields on the CPU and on every usable Vulkan device must be
// identical, bit for bit, however many iterations run in one submission.
// Exit 77 (skipped) when no Vulkan device is available.

#include "dstns/compute/field.hpp"
#include "dstns/compute/vulkan.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>

namespace {
using namespace dstns::compute;

int failures = 0, checks = 0;

Field2D random_field(std::uint32_t w, std::uint32_t h, std::uint64_t seed) {
    Field2D f{w, h, std::vector<std::uint32_t>(std::size_t(w) * h)};
    std::uint64_t x = seed * 0x9E3779B97F4A7C15ull + 1;
    for (auto& c : f.cells) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        c = static_cast<std::uint32_t>(x >> 34); // up to 2^30: a Q30 depth
    }
    if (!f.cells.empty()) f.cells[f.cells.size() / 2] = 0xFFFFFFFFu; // a spike at the top of the range
    return f;
}
} // namespace

int main() {
    std::cout << "[field] structured-grid kernels on the CPU and on Vulkan\n";
    ComputeOptions probe;
    probe.allow_software_vulkan = true;
    probe.cache_dir.clear();
    if (const char* v = std::getenv("DSTNS_VULKAN_VALIDATION")) probe.validation = std::string(v) == "1";
    const auto report = vulkan_diagnostics(probe);
    std::vector<std::string> devices;
    for (const auto& d : report["devices"])
        if (d.contains("self_test") && d["self_test"].value("passed", false)) devices.push_back(std::to_string(d["index"].get<int>()));
    if (devices.empty()) {
        std::cout << "SKIPPED: no usable Vulkan device\n";
        return 77;
    }
    struct Case { std::uint32_t w, h, iterations; };
    const Case cases[] = {{1, 1, 3}, {1, 300, 7}, {300, 1, 7}, {127, 129, 1}, {257, 131, 64}, {512, 512, 300}};
    for (const auto& index : devices) {
        ComputeOptions options = probe;
        options.device = index;
        std::string reason;
        int validation_errors = 0;
        auto solver = create_vulkan_field_solver(options, [&](const std::string& level, const std::string& message) {
            if (level == "ERROR" && message.rfind("compute.vulkan.validation", 0) == 0) {
                ++validation_errors;
                std::cerr << message << "\n";
            }
        }, reason);
        if (!solver) {
            ++failures;
            std::cerr << "FAIL: no field solver on device " << index << ": " << reason << "\n";
            continue;
        }
        std::cout << "device " << solver->device() << "\n";
        for (const auto& c : cases) {
            auto cpu = random_field(c.w, c.h, c.w * 31 + c.h);
            solver->load(cpu);
            const auto t0 = std::chrono::steady_clock::now();
            solver->diffuse(16384, c.iterations); // rate 0.25
            const auto gpu = solver->read();
            const auto t1 = std::chrono::steady_clock::now();
            diffuse(cpu, 16384, c.iterations);
            const auto t2 = std::chrono::steady_clock::now();
            ++checks;
            if (gpu.cells != cpu.cells) {
                ++failures;
                std::cerr << "FAIL: " << c.w << "x" << c.h << " after " << c.iterations << " iterations differs\n";
                continue;
            }
            std::cout << "  ok  " << c.w << "x" << c.h << ", " << c.iterations << " iterations in one submission"
                      << " (GPU " << std::chrono::duration<double, std::milli>(t1 - t0).count() << " ms, CPU "
                      << std::chrono::duration<double, std::milli>(t2 - t1).count() << " ms)\n";
        }
        // A second batch continues from the device's state, not from the start.
        auto cpu = random_field(200, 100, 9);
        solver->load(cpu);
        solver->diffuse(9000, 11);
        solver->diffuse(9000, 20);
        diffuse(cpu, 9000, 31);
        ++checks;
        if (solver->read().cells != cpu.cells) {
            ++failures;
            std::cerr << "FAIL: consecutive batches differ from one run of the same length\n";
        } else {
            std::cout << "  ok  consecutive batches continue on the device\n";
        }
        solver.reset();
        ++checks;
        if (validation_errors) {
            ++failures;
            std::cerr << "FAIL: " << validation_errors << " Vulkan validation error(s)\n";
        }
    }
    std::cout << "[field] " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
