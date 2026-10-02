// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Fixed-point state shared by every compute backend.
//
// The scenario's static data is quantised once into StaticTables; the dynamic
// state of a run is one flat array of 32-bit words; the host's inputs to a
// step (operator controls, demand couplings, signal phases) are another. Both
// arrays have the same layout on the CPU and on a GPU, so moving state between
// backends is a copy, never a conversion.

#include "dstns/compute/physics.hpp"
#include "dstns/model.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <utility>
#include <vector>

namespace dstns::compute {

// --- Quantisation ---------------------------------------------------------------
// Every conversion from a host double into a fixed-point word happens here, on
// the CPU, before any backend sees it. Values are rounded to the nearest
// representable value and clamped to the format's range.

[[nodiscard]] std::uint32_t to_q30(double value);          // [0, 4)
[[nodiscard]] std::uint32_t to_q16(double value);          // [0, 65536)
[[nodiscard]] std::int32_t to_q28(double value);           // (-8, 8)
[[nodiscard]] std::int32_t to_pos(double metres);          // 1/256 m, |x| <= 2^30
[[nodiscard]] std::uint32_t to_pos_radius(double metres);  // 1/256 m, at least 1

[[nodiscard]] constexpr double from_q30(std::uint64_t v) { return double(v) / 1073741824.0; }
[[nodiscard]] constexpr double from_q16(std::uint64_t v) { return double(v) / 65536.0; }
[[nodiscard]] constexpr double from_q8(std::int64_t v) { return double(v) / 256.0; }

/// Element counts rounded up so that every field of a structure of arrays
/// starts on a 256-byte boundary.
[[nodiscard]] constexpr std::uint32_t stride_for(std::size_t count) {
    return static_cast<std::uint32_t>((count + 63) / 64 * 64);
}

// --- Static tables ----------------------------------------------------------------

struct StaticTables {
    std::uint32_t node_count{}, edge_count{}, signal_count{};
    std::uint32_t node_stride{}, edge_stride{}, signal_stride{};
    std::vector<std::uint32_t> node_words; // NODE_STATIC_FIELDS * node_stride
    std::vector<std::uint32_t> edge_words; // EDGE_STATIC_FIELDS * edge_stride
    std::uint64_t weight_total{};          // sum of ES_WEIGHT over traversable edges
    // Which edges carry a scheduled incident, so a step recomposes only those.
    std::vector<std::pair<std::uint32_t, std::vector<std::uint32_t>>> incident_edges;

    [[nodiscard]] std::uint32_t node(std::uint32_t field, std::uint32_t i) const { return node_words[std::size_t(field) * node_stride + i]; }
    [[nodiscard]] std::uint32_t edge(std::uint32_t field, std::uint32_t i) const { return edge_words[std::size_t(field) * edge_stride + i]; }

    // Layout of the dynamic arrays derived from the counts.
    [[nodiscard]] std::size_t edge_state_base() const { return std::size_t(physics::NODE_STATE_FIELDS) * node_stride; }
    [[nodiscard]] std::size_t state_words() const { return edge_state_base() + std::size_t(physics::EDGE_STATE_FIELDS) * edge_stride; }
    [[nodiscard]] std::size_t override_base() const { return std::size_t(physics::EDGE_INPUT_FIELDS) * edge_stride; }
    [[nodiscard]] std::size_t phase_base() const { return override_base() + node_stride; }
    [[nodiscard]] std::size_t input_words() const { return phase_base() + signal_stride; }

    [[nodiscard]] std::size_t node_state(std::uint32_t field, std::uint32_t i) const { return std::size_t(field) * node_stride + i; }
    [[nodiscard]] std::size_t edge_state(std::uint32_t field, std::uint32_t i) const { return edge_state_base() + std::size_t(field) * edge_stride + i; }
    [[nodiscard]] std::size_t edge_input(std::uint32_t field, std::uint32_t i) const { return std::size_t(field) * edge_stride + i; }

    /// Bytes a backend must hold for one scenario: static tables, inputs, and
    /// one copy of the state. Backends add their own working copies.
    [[nodiscard]] std::size_t footprint_bytes() const {
        return (node_words.size() + edge_words.size() + input_words() + state_words()) * sizeof(std::uint32_t);
    }
};

/// Quantise a scenario. Deterministic: the same scenario gives the same words.
[[nodiscard]] StaticTables build_static_tables(const Scenario& scenario);

/// The state before the first step: no rain or flood, traversable edges at
/// free speed and full capacity, every multiplier 1.
[[nodiscard]] std::vector<std::uint32_t> initial_state(const StaticTables& tables);

// --- Inputs -------------------------------------------------------------------------

/// The host's inputs to the step, with change tracking so that a backend with
/// its own copy uploads only words that changed since the last step.
class InputMirror {
public:
    void reset(const StaticTables& tables);
    void set(std::size_t offset, std::uint32_t value) {
        if (words_[offset] == value) return;
        words_[offset] = value;
        if (!dirty_flag_[offset]) {
            dirty_flag_[offset] = true;
            dirty_.push_back(static_cast<std::uint32_t>(offset));
        }
    }
    [[nodiscard]] std::uint32_t get(std::size_t offset) const { return words_[offset]; }
    [[nodiscard]] const std::vector<std::uint32_t>& words() const { return words_; }
    [[nodiscard]] std::span<const std::uint32_t> dirty() const { return dirty_; }
    /// Set when a backend's copy must be replaced wholesale (a new scenario, a
    /// backend switch), rather than patched.
    [[nodiscard]] bool full_upload_pending() const { return full_; }
    void request_full_upload() { full_ = true; }
    void mark_uploaded();
private:
    std::vector<std::uint32_t> words_;
    std::vector<bool> dirty_flag_;
    std::vector<std::uint32_t> dirty_;
    bool full_{true};
};

// --- Step parameters ------------------------------------------------------------------

/// Per-step scalars and the active storms and surges, already quantised.
struct StepParams {
    std::vector<std::uint32_t> words;
    void begin(const StaticTables& tables, std::uint32_t virtual_s, std::uint32_t dt, std::uint32_t modules, std::uint32_t day_q30);
    void add_storm(std::int32_t x, std::int32_t y, std::uint32_t radius, std::uint32_t intensity_q30);
    void add_surge(std::int32_t x, std::int32_t y, std::uint32_t radius, std::uint32_t factor_q16);
    [[nodiscard]] std::uint32_t storms() const { return words[physics::P_STORM_COUNT]; }
    [[nodiscard]] std::uint32_t surges() const { return words[physics::P_SURGE_COUNT]; }
};

/// What a step reports back besides the state itself.
struct StepResult {
    std::uint32_t transitions{};   // edges whose flood flag changed this step
    std::uint64_t congestion_sum{}; // sum of congestion_contribution
};

/// Run one step on the CPU, in place. The reference implementation that every
/// accelerator backend is compared against. `begin`/`end` select a contiguous
/// range of edges, so the work can be split across threads; nodes are always
/// done in full by the caller of the first range.
void cpu_node_pass(const StaticTables& tables, const StepParams& params, std::vector<std::uint32_t>& state);
void cpu_edge_pass(const StaticTables& tables, const StepParams& params, const std::vector<std::uint32_t>& inputs,
                   std::vector<std::uint32_t>& state, std::uint32_t begin, std::uint32_t end, StepResult& result);

} // namespace dstns::compute
