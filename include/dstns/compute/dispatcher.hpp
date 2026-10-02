// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// ComputeDispatcher: the engine's single point of contact for the physics
// step. It owns the run's fixed-point state and inputs, chooses which backend
// executes each step, moves state between backends at step boundaries, and
// falls back to the CPU when an accelerator fails. The engine expresses what a
// step needs (storms, surges, controls) in its own terms; nothing here asks it
// which hardware is running.

#include "dstns/compute/backend.hpp"
#include "dstns/compute/conditions.hpp"
#include "dstns/compute/options.hpp"
#include "dstns/compute/state.hpp"
#include "dstns/graph.hpp"

#include <chrono>
#include <map>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dstns::compute {

struct StormSample { double x_m{}, y_m{}, radius_m{}, intensity{}; };
struct SurgeSample { std::uint32_t node{}; double factor{1}, radius_m{}; };

/// What the engine knows about one step, in model units.
struct StepRequest {
    std::uint32_t virtual_s{}, dt{1};
    double day_profile{};
    bool traffic{true}, signals{true}, buildings{true}, flooding{true};
    std::vector<StormSample> storms; // active storms, in schedule order then manual order
    std::vector<SurgeSample> surges; // active surges
};

struct StepOutcome {
    std::uint32_t transitions{};     // edges whose flood flag changed
    double congestion_index{};       // weighted network congestion, 0..100
};

struct ManualControl { double speed_multiplier{1}, capacity_multiplier{1}; bool closed{}; };

/// The authoritative state could not be recovered from a failed device, even
/// from the dispatcher's own journal. A last resort: the engine restores its
/// latest checkpoint and replays on the CPU.
class StateLost : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class ComputeDispatcher final : public DynamicStateSource {
public:
    explicit ComputeDispatcher(ComputeOptions options = {}, LogSink log = {});
    ~ComputeDispatcher() override;
    ComputeDispatcher(const ComputeDispatcher&) = delete;
    ComputeDispatcher& operator=(const ComputeDispatcher&) = delete;

    /// Bring up accelerators now, so system information can report them before
    /// the first world. Otherwise it happens at the first world large enough to
    /// want one. Idempotent. Throws only when require_vulkan cannot be met.
    void initialize();

    // --- World lifecycle ----------------------------------------------------
    void install(const Scenario& scenario);
    void release();
    [[nodiscard]] bool installed() const { return installed_; }
    [[nodiscard]] const StaticTables& tables() const { return tables_; }

    // --- Inputs, between steps ----------------------------------------------
    void set_signal_phase(std::uint32_t signal, std::uint32_t phase);
    /// 0 clears the override; 1 forces north-south green, 2 east-west green.
    void set_signal_override(std::uint32_t node, int phase);
    /// Make the overrides exactly those in `overrides` (node -> phase).
    void sync_signal_overrides(const std::map<std::uint32_t, int>& overrides);
    void set_attraction(std::uint32_t edge, double value);
    /// An operator override. Also closes or reopens the edge immediately, as
    /// the override did before the compute layer existed.
    void set_manual(std::uint32_t edge, const ManualControl& control);
    [[nodiscard]] ManualControl manual(std::uint32_t edge) const;
    /// Recompose the incident multipliers of the edges that have incidents.
    void update_incidents(const Scenario& scenario, std::uint32_t virtual_s, bool enabled);

    // --- The step -----------------------------------------------------------
    StepOutcome step(const StepRequest& request);

    // --- State --------------------------------------------------------------
    /// The complete state, for a checkpoint. Downloads from a device if needed.
    [[nodiscard]] std::vector<std::uint32_t> export_state();
    void import_state(const std::vector<std::uint32_t>& state);
    void reset_state();
    [[nodiscard]] EdgeConditions conditions() const;
    [[nodiscard]] double edge_flood(std::uint32_t edge) const;
    [[nodiscard]] bool flood_transition(std::uint32_t edge) const;
    void materialize(std::vector<NodeDynamic>& nodes, std::vector<EdgeDynamic>& edges, std::uint64_t revision) const override;

    // --- Backends -----------------------------------------------------------
    [[nodiscard]] BackendType active() const { return active_; }
    /// Move the run to another backend at this step boundary. Returns false,
    /// leaving the run where it is, if that backend cannot take it.
    bool select(BackendType type, const std::string& reason);
    /// Set after a StateLost, until the engine has replayed from a checkpoint.
    [[nodiscard]] bool needs_recovery() const { return needs_recovery_; }
    void recovered() { needs_recovery_ = false; }
    [[nodiscard]] const ComputeOptions& options() const { return options_; }
    /// System information and telemetry, as reported by the API.
    [[nodiscard]] nlohmann::json describe() const;
private:
    void log(const std::string& level, const std::string& message) const;
    void fail_vulkan(const std::string& reason);
    void choose_backend();
    void calibrate();
    void ensure_host_state();
    void take_shadow();
    bool rebuild_from_shadow();
    void patch_state(std::size_t offset, std::uint32_t value);
    void run_cpu(StepResult& result);
    void verify_step(const std::vector<std::uint32_t>& before, const StepResult& gpu);
    void record(BackendType ran, const StepTelemetry& t, double total_ms);

    ComputeOptions options_;
    LogSink log_;
    std::unique_ptr<IComputeBackend> cpu_;
    std::unique_ptr<IComputeBackend> vulkan_;
    bool vulkan_initialized_{};
    BackendHealth vulkan_health_{BackendHealth::Unavailable};
    std::string vulkan_reason_;
    BackendType active_{BackendType::Cpu};
    std::string selection_reason_{"no world installed"};
    bool installed_{};
    bool needs_recovery_{};

    StaticTables tables_;
    // The host copy of the state. Complete whenever the CPU is active; after an
    // accelerated step only EV_RAIN..EV_FLAGS are current until the next
    // download. Mutable because materialising the view may download.
    mutable std::vector<std::uint32_t> state_;
    mutable bool host_complete_{true};
    InputMirror inputs_;
    StepParams params_;
    std::vector<std::pair<std::uint32_t, std::uint32_t>> patches_;
    std::vector<std::int32_t> overrides_; // per node, as last set
    std::vector<std::uint32_t> override_nodes_; // nodes with a non-zero override

    // Recovery from a lost device. While an accelerator runs, the host keeps
    // the last complete state it saw (from a checkpoint, a download, or at
    // least every kShadowInterval steps) and a journal of every step's inputs
    // since. Replaying the journal on the CPU reproduces the lost state
    // exactly, operator actions included.
    struct JournalEntry {
        std::vector<std::uint32_t> params;
        std::vector<std::pair<std::uint32_t, std::uint32_t>> inputs, patches;
    };
    static constexpr std::size_t kShadowInterval = 300;
    std::vector<std::uint32_t> shadow_state_, shadow_inputs_;
    std::vector<JournalEntry> journal_;
    std::uint64_t replays_{};

    // Telemetry.
    struct Calibration { bool ran{}; double cpu_ms{}, vulkan_ms{}; std::string chosen; };
    Calibration calibration_;
    StepTelemetry last_;
    BackendType last_backend_{BackendType::Cpu};
    double last_total_ms_{};
    std::uint64_t steps_cpu_{}, steps_vulkan_{}, fallbacks_{}, verified_{}, downloads_{};
    mutable std::uint64_t view_downloads_{};
    double total_ms_cpu_{}, total_ms_vulkan_{};
    std::uint64_t upload_bytes_{}, readback_bytes_{};
    std::string last_failure_;
};

} // namespace dstns::compute
