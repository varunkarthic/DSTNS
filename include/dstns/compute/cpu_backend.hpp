// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/compute/backend.hpp"

#include <memory>

namespace dstns::compute {

/// The reference backend: the physics step on the CPU, operating directly on
/// the dispatcher's host state. Large worlds are split across a fixed pool of
/// threads by contiguous edge ranges. Every edge is independent and the
/// reductions are integer sums, so the result does not depend on the split.
class CpuComputeBackend final : public IComputeBackend {
public:
    /// `threads` 0 chooses one per hardware thread, up to 8.
    explicit CpuComputeBackend(std::uint32_t threads = 1);
    ~CpuComputeBackend() override;
    CpuComputeBackend(const CpuComputeBackend&) = delete;
    CpuComputeBackend& operator=(const CpuComputeBackend&) = delete;

    [[nodiscard]] BackendType type() const override { return BackendType::Cpu; }
    [[nodiscard]] ComputeCapabilities capabilities() const override;
    void install(const StaticTables& tables) override;
    void release() override;
    void upload_state(const std::vector<std::uint32_t>&) override {}
    void step(const StepWork& work, std::vector<std::uint32_t>& host_state, StepResult& result) override;
    void download_state(std::vector<std::uint32_t>&) override {}
    [[nodiscard]] bool host_resident() const override { return true; }
    void synchronize() override {}
    [[nodiscard]] StepTelemetry last_step() const override { return telemetry_; }

    /// Edges below which a step stays on one thread: dividing a small world
    /// costs more in hand-offs than it saves.
    static constexpr std::uint32_t kParallelEdges = 32768;
private:
    class Pool;
    const StaticTables* tables_{};
    std::unique_ptr<Pool> pool_;
    std::uint32_t threads_{1};
    StepTelemetry telemetry_;
};

} // namespace dstns::compute
