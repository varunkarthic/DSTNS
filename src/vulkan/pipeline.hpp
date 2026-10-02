// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Shader modules, compute pipelines, descriptor sets and the pipeline cache.
// All created once per device (pipelines) or per world (descriptor sets) and
// reused for every step.

#include "context.hpp"
#include "shaders.hpp"

#include <filesystem>
#include <string>
#include <vector>

namespace dstns::vulkan {

/// A descriptor-set layout of N storage buffers at bindings 0..N-1, and the
/// pipeline layout around it. Every DSTNS kernel uses one set of storage
/// buffers; nothing else.
class BindingLayout {
public:
    BindingLayout(const Device& device, std::uint32_t bindings);
    ~BindingLayout();
    BindingLayout(const BindingLayout&) = delete;
    BindingLayout& operator=(const BindingLayout&) = delete;
    [[nodiscard]] VkDescriptorSetLayout set_layout() const { return set_layout_; }
    [[nodiscard]] VkPipelineLayout pipeline_layout() const { return pipeline_layout_; }
    [[nodiscard]] std::uint32_t bindings() const { return bindings_; }
private:
    const Device& device_;
    VkDescriptorSetLayout set_layout_{};
    VkPipelineLayout pipeline_layout_{};
    std::uint32_t bindings_{};
};

/// The pipeline cache, persisted per device and driver under the cache
/// directory. The file carries the shader bundle's hash and is checked against
/// the device's own cache header before use; anything that does not match, or
/// does not parse, is discarded and rebuilt. Never a correctness dependency.
class PipelineCache {
public:
    PipelineCache(const Device& device, const std::string& directory, const std::string& bundle_hash, const compute::LogSink& log);
    ~PipelineCache();
    PipelineCache(const PipelineCache&) = delete;
    PipelineCache& operator=(const PipelineCache&) = delete;
    [[nodiscard]] VkPipelineCache handle() const { return cache_; }
    /// "warm" (loaded from disk), "cold" (new), or "disabled".
    [[nodiscard]] const std::string& state() const { return state_; }
    void save() const;
private:
    const Device& device_;
    VkPipelineCache cache_{};
    std::filesystem::path path_;
    std::string bundle_hash_;
    std::string state_{"disabled"};
    compute::LogSink log_;
};

class ComputePipeline {
public:
    ComputePipeline(const Device& device, const BindingLayout& layout, const shaders::Binary& shader,
                    std::uint32_t workgroup_size, VkPipelineCache cache);
    ~ComputePipeline();
    ComputePipeline(const ComputePipeline&) = delete;
    ComputePipeline& operator=(const ComputePipeline&) = delete;
    [[nodiscard]] VkPipeline handle() const { return pipeline_; }
    [[nodiscard]] const BindingLayout& layout() const { return layout_; }
private:
    const Device& device_;
    const BindingLayout& layout_;
    VkPipeline pipeline_{};
};

/// A pool sized for a fixed number of sets of storage buffers.
class DescriptorPool {
public:
    DescriptorPool(const Device& device, std::uint32_t sets, std::uint32_t buffers);
    ~DescriptorPool();
    DescriptorPool(const DescriptorPool&) = delete;
    DescriptorPool& operator=(const DescriptorPool&) = delete;
    [[nodiscard]] VkDescriptorSet allocate(const BindingLayout& layout);
private:
    const Device& device_;
    VkDescriptorPool pool_{};
};

/// Point binding i of `set` at buffers[i] (whole buffer).
void write_set(const Device& device, VkDescriptorSet set, const std::vector<VkBuffer>& buffers);

} // namespace dstns::vulkan
