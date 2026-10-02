// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// One Vulkan device, ready for compute: the instance, the selected device, its
// pipeline cache, a command pool, a timeline and timestamp queries, verified
// by a self-test before anything uses it. Every Vulkan workload is built on
// this: the road-network physics (backend.hpp) and the structured-grid field
// solvers (field.cpp) that future weather and water models extend. A workload
// adds only its own pipelines and buffers.

#include "context.hpp"
#include "executor.hpp"
#include "memory.hpp"
#include "pipeline.hpp"

#include "dstns/compute/options.hpp"

#include <memory>
#include <vector>

namespace dstns::vulkan {

class Gpu {
public:
    /// Select and open the device the options name, and prove it with the
    /// self-test. Throws on any failure.
    Gpu(const compute::ComputeOptions& options, const compute::LogSink& log);
    ~Gpu();
    Gpu(const Gpu&) = delete;
    Gpu& operator=(const Gpu&) = delete;

    [[nodiscard]] const Instance& instance() const { return *instance_; }
    [[nodiscard]] const Device& device() const { return *device_; }
    [[nodiscard]] const DeviceInfo& info() const { return info_; }
    [[nodiscard]] const std::vector<DeviceInfo>& devices() const { return devices_; }
    [[nodiscard]] PipelineCache& cache() { return *cache_; }
    [[nodiscard]] const CommandPool& commands() const { return *commands_; }
    [[nodiscard]] Timeline& timeline() { return *timeline_; }
    [[nodiscard]] const compute::ComputeOptions& options() const { return options_; }
    /// The workgroup size every pipeline on this device is specialised with.
    [[nodiscard]] std::uint32_t workgroup() const { return workgroup_; }
    /// Two storage buffers at bindings 0 and 1: the layout of the scatter and
    /// self-test kernels.
    [[nodiscard]] const BindingLayout& pair_layout() const { return *pair_layout_; }
    [[nodiscard]] bool lost() const { return lost_; }
    void mark_lost() { lost_ = true; }

    /// A compute pipeline for the embedded shader `name`, specialised with this
    /// device's workgroup size and backed by its pipeline cache.
    [[nodiscard]] std::unique_ptr<ComputePipeline> pipeline(const BindingLayout& layout, const char* name);

    /// Record commands into the shared one-shot command buffer, submit them and
    /// wait. For uploads, downloads and other work outside a step's hot path.
    template<class Record> void run(Record&& record) {
        begin_one_shot();
        record(one_shot_);
        submit_one_shot();
    }
    /// Copy between buffers through run(); `to_host` makes the result visible
    /// to the host, otherwise to the next compute or transfer work.
    void copy(VkBuffer source, VkDeviceSize source_offset, VkBuffer target, VkDeviceSize target_offset, VkDeviceSize bytes, bool to_host);

    /// Run the self-test kernel; returns its duration in milliseconds.
    double self_test();
    /// Wait for everything submitted so far.
    void synchronize();
private:
    void begin_one_shot();
    void submit_one_shot();

    compute::ComputeOptions options_;
    compute::LogSink log_;
    std::unique_ptr<Instance> instance_;
    std::vector<DeviceInfo> devices_;
    DeviceInfo info_;
    std::unique_ptr<Device> device_;
    std::unique_ptr<PipelineCache> cache_;
    std::unique_ptr<BindingLayout> pair_layout_;
    std::unique_ptr<ComputePipeline> self_test_;
    std::unique_ptr<CommandPool> commands_;
    std::unique_ptr<Timeline> timeline_;
    VkCommandBuffer one_shot_{};
    std::uint32_t workgroup_{};
    bool lost_{};
};

} // namespace dstns::vulkan
