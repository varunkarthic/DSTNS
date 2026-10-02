// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "gpu.hpp"

#include "dstns/compute/backend.hpp"
#include "dstns/compute/options.hpp"

#include <memory>

namespace dstns::vulkan {

/// The physics step on a Vulkan device.
///
/// Per process: an instance, the selected device, its pipelines and a
/// timeline. Per world: persistent buffers for the static tables, the inputs,
/// two copies of the state (committed and candidate), the reductions, and
/// host-visible upload and readback areas; plus two command buffers recorded
/// once (one per parity of the state pair) and resubmitted every step.
///
/// One step, one submission:
///   scatter the host's changed inputs and state patches into device buffers
///   node pass  -> barrier -> edge pass (+ workgroup reductions) -> barrier
///   copy the three host-facing edge fields, partial sums and counters to the
///   readback area -> signal the timeline.
/// The host waits on that timeline value, reads the readback area, and only
/// then swaps committed and candidate. A failure at any point leaves the
/// committed copy untouched.
class VulkanComputeBackend final : public compute::IComputeBackend {
public:
    VulkanComputeBackend(const compute::ComputeOptions& options, const compute::LogSink& log);
    ~VulkanComputeBackend() override;
    VulkanComputeBackend(const VulkanComputeBackend&) = delete;
    VulkanComputeBackend& operator=(const VulkanComputeBackend&) = delete;

    [[nodiscard]] compute::BackendType type() const override { return compute::BackendType::Vulkan; }
    [[nodiscard]] compute::ComputeCapabilities capabilities() const override;
    void install(const compute::StaticTables& tables) override;
    void release() override;
    void upload_state(const std::vector<std::uint32_t>& state) override;
    void step(const compute::StepWork& work, std::vector<std::uint32_t>& host_state, compute::StepResult& result) override;
    void download_state(std::vector<std::uint32_t>& host_state) override;
    [[nodiscard]] bool host_resident() const override { return false; }
    void synchronize() override;
    [[nodiscard]] compute::StepTelemetry last_step() const override { return telemetry_; }

    [[nodiscard]] std::uint32_t validation_errors() const { return gpu_->instance().counters().errors; }
    [[nodiscard]] const DeviceInfo& device_info() const { return gpu_->info(); }
    [[nodiscard]] const std::vector<DeviceInfo>& devices() const { return gpu_->devices(); }
private:
    struct World;
    void guard() const;
    void record_step(int parity);
    void ensure_capacity(Buffer& buffer, VkDeviceSize bytes, VkBufferUsageFlags usage, MemoryUse use, const char* label, bool& changed);

    compute::ComputeOptions options_;
    compute::LogSink log_;
    // Declared in dependency order: destroyed in reverse, world first, device last.
    std::unique_ptr<Gpu> gpu_;
    std::unique_ptr<BindingLayout> physics_layout_;
    std::unique_ptr<ComputePipeline> node_pipeline_, edge_pipeline_, scatter_pipeline_;
    std::unique_ptr<Timestamps> timestamps_;
    VkCommandBuffer step_commands_[2]{};
    std::unique_ptr<World> world_;
    int parity_{};
    std::uint64_t steps_{};
    compute::StepTelemetry telemetry_;
};

} // namespace dstns::vulkan
