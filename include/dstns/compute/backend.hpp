// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// A compute backend executes the physics step on some kind of hardware. The
// engine never talks to one directly: it talks to the ComputeDispatcher, which
// owns the host copy of the state, chooses a backend, and moves state between
// backends at step boundaries.

#include "dstns/compute/state.hpp"

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dstns::compute {

enum class BackendType { Cpu, Vulkan };
[[nodiscard]] const char* to_string(BackendType type);

/// Where a backend stands. `Failed` is permanent for the process: a broken
/// device is not retried every second.
enum class BackendHealth { Unavailable, Disabled, Available, Active, Degraded, Failed };
[[nodiscard]] const char* to_string(BackendHealth health);

/// What a backend runs on. Descriptive only: none of it enters a scenario hash.
struct ComputeCapabilities {
    bool available{};
    bool hardware_accelerated{};
    bool deterministic{true};       // integer kernels: identical results to the CPU
    std::string name, vendor, driver, device_type, api_version, driver_version, uuid;
    std::uint32_t vendor_id{}, device_id{};
    std::uint64_t device_memory_bytes{};
    bool moltenvk{}, portability_subset{}, timestamps{}, synchronization2{}, validation{};
    bool unified_memory{};
    std::uint32_t queue_family{}, workgroup_size{}, threads{1};
    std::string pipeline_cache;     // "warm", "cold", "disabled"
    std::string shader_bundle;      // SHA-256 of the embedded SPIR-V
};

/// Timing and traffic of the most recent step, for telemetry.
struct StepTelemetry {
    double host_ms{};      // wall time of the backend call
    double device_ms{};    // GPU execution time, when timestamps are available
    std::uint64_t upload_bytes{}, readback_bytes{};
    std::uint32_t dispatches{};
    std::vector<std::pair<std::string, double>> passes; // per-pass device time
};

/// A failure inside an accelerator. `state_intact` says whether the committed
/// state on the device can still be read back; after a lost device it cannot.
class ComputeError : public std::runtime_error {
public:
    ComputeError(const std::string& message, bool state_intact, bool device_lost = false)
        : std::runtime_error(message), state_intact_(state_intact), device_lost_(device_lost) {}
    [[nodiscard]] bool state_intact() const { return state_intact_; }
    [[nodiscard]] bool device_lost() const { return device_lost_; }
private:
    bool state_intact_;
    bool device_lost_;
};

/// Inputs to one step that the backend may need to upload.
struct StepWork {
    const StepParams& params;
    const InputMirror& inputs;
    // Words of the committed state the host changed between steps (an operator
    // closing a road), as (offset, value). Applied before the step runs.
    const std::vector<std::pair<std::uint32_t, std::uint32_t>>& state_patches;
};

class IComputeBackend {
public:
    virtual ~IComputeBackend() = default;
    [[nodiscard]] virtual BackendType type() const = 0;
    [[nodiscard]] virtual ComputeCapabilities capabilities() const = 0;

    /// Prepare for a scenario: allocate and upload the static tables. Called
    /// once per world; the backend keeps everything resident until release().
    virtual void install(const StaticTables& tables) = 0;
    virtual void release() = 0;

    /// Make the backend's committed state equal to `state` (a new world, a
    /// restored checkpoint, a switch from another backend).
    virtual void upload_state(const std::vector<std::uint32_t>& state) = 0;

    /// Advance one step. On return the committed state is the new state, and
    /// `host_state` holds at least the fields EV_RAIN..EV_FLAGS of every edge.
    /// Throws ComputeError and leaves the committed state unchanged on failure.
    virtual void step(const StepWork& work, std::vector<std::uint32_t>& host_state, StepResult& result) = 0;

    /// Copy the complete committed state to the host.
    virtual void download_state(std::vector<std::uint32_t>& host_state) = 0;

    /// True if `host_state` is the backend's own state, so it never needs a
    /// download (the CPU backend).
    [[nodiscard]] virtual bool host_resident() const = 0;

    /// Wait for all submitted work. Used at shutdown and before a switch.
    virtual void synchronize() = 0;

    [[nodiscard]] virtual StepTelemetry last_step() const = 0;
};

using LogSink = std::function<void(const std::string& level, const std::string& message)>;

} // namespace dstns::compute
