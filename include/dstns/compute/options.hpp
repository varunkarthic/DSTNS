// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include <cstdint>
#include <map>
#include <string>

namespace dstns::compute {

/// What the operator asked for.
///   auto    use an accelerator when one is healthy and measurably faster for
///           this world; otherwise the CPU
///   cpu     always the CPU
///   vulkan  prefer Vulkan for every world, whatever its size; fall back to the
///           CPU with a logged reason if it cannot run (or refuse to start, with
///           require_vulkan)
enum class BackendPreference { Auto, Cpu, Vulkan };
[[nodiscard]] const char* to_string(BackendPreference preference);
[[nodiscard]] BackendPreference parse_preference(const std::string& text);

/// Deliberate failures for testing the fallback paths. Never set in production.
struct FaultInjection {
    enum class Kind { None, Initialisation, Allocation, Pipeline, Submit, DeviceLost, Mismatch };
    Kind kind{Kind::None};
    std::uint32_t at_step{0}; // for Submit, DeviceLost and Mismatch: the backend step that fails
};

struct ComputeOptions {
    BackendPreference backend{BackendPreference::Auto};
    bool allow_vulkan{true};
    bool allow_software_vulkan{false}; // e.g. Mesa lavapipe: for testing, not acceleration
    bool require_vulkan{false};        // with backend=vulkan: refuse to start without it
    bool verify{false};                // recompute every accelerated step on the CPU and compare
    bool validation{false};            // Khronos validation layers, when installed
    std::string device{"auto"};        // auto | index | UUID | name substring
    std::uint32_t workgroup_size{0};   // 0: chosen from the device's limits
    // Below these sizes the CPU always wins (measured; see docs/deployment/
    // performance.md). Above them, auto mode times both backends on the world
    // itself and keeps the faster.
    std::uint32_t min_nodes{20000};
    std::uint32_t min_edges{40000};
    bool calibrate{true};
    std::uint32_t cpu_threads{0};      // 0: one per hardware thread, up to 8
    std::string cache_dir{"data/cache/vulkan"}; // empty disables the pipeline cache
    std::string library;               // explicit Vulkan loader or ICD library path
    double timeout_s{10.0};            // a step that takes longer is a hung device
    FaultInjection fault;

    /// Apply DSTNS_COMPUTE_*, DSTNS_GPU_* and DSTNS_VULKAN_* overrides. Throws
    /// std::invalid_argument for a malformed value rather than ignoring it.
    void apply_environment();
    /// The resolved options, for system information. Paths are not included.
    [[nodiscard]] std::map<std::string, std::string> describe() const;
};

/// Parse 1/0, true/false, on/off, yes/no. Throws std::invalid_argument.
[[nodiscard]] bool parse_flag(const std::string& name, const std::string& value);

} // namespace dstns::compute
