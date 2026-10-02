// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "gpu.hpp"

#include "dstns/compute/physics.hpp"

#include <chrono>
#include <cstring>
#include <sstream>

namespace dstns::vulkan {
namespace {

std::uint32_t choose_workgroup(const DeviceInfo& info, std::uint32_t requested) {
    const auto& limits = info.properties.limits;
    const auto fits = [&](std::uint32_t size) {
        return limits.maxComputeWorkGroupSize[0] >= size && limits.maxComputeWorkGroupInvocations >= size &&
               // the edge pass keeps one 64-bit partial sum per invocation in shared memory
               limits.maxComputeSharedMemorySize >= 256 * sizeof(std::uint64_t);
    };
    if (requested && fits(requested)) return requested;
    // 128 is the measured default (docs/deployment/performance.md): a multiple
    // of every vendor's SIMD width (32 or 64) and within every device's limits.
    for (const std::uint32_t size : {128u, 64u})
        if (fits(size)) return size;
    return 64;
}

std::uint32_t groups(std::uint32_t items, std::uint32_t size) { return (items + size - 1) / size; }

} // namespace

Gpu::Gpu(const compute::ComputeOptions& options, const compute::LogSink& log) : options_(options), log_(log) {
    instance_ = std::make_unique<Instance>(options, log);
    devices_ = enumerate_devices(*instance_, options.allow_software_vulkan);
    std::string reason;
    const auto* chosen = select_device(devices_, options, reason);
    if (!chosen) throw std::runtime_error(reason);
    info_ = *chosen;
    device_ = std::make_unique<Device>(*instance_, info_);
    workgroup_ = choose_workgroup(info_, options.workgroup_size);
    cache_ = std::make_unique<PipelineCache>(*device_, options.cache_dir, shaders::kBundleSha256, log);
    pair_layout_ = std::make_unique<BindingLayout>(*device_, 2);
    self_test_ = pipeline(*pair_layout_, "self_test");
    commands_ = std::make_unique<CommandPool>(*device_, static_cast<std::uint32_t>(info_.queue_family));
    timeline_ = std::make_unique<Timeline>(*device_);
    one_shot_ = commands_->allocate();
    // A device is used only after it has proved it computes correctly.
    self_test();
    cache_->save();
}

Gpu::~Gpu() {
    try {
        synchronize();
    } catch (...) {
    }
    if (cache_ && !lost_) cache_->save();
}

std::unique_ptr<ComputePipeline> Gpu::pipeline(const BindingLayout& layout, const char* name) {
    const auto* binary = shaders::find(name);
    if (!binary) throw std::runtime_error(std::string("shader ") + name + " is missing from the bundle");
    return std::make_unique<ComputePipeline>(*device_, layout, *binary, workgroup_, cache_->handle());
}

void Gpu::synchronize() {
    if (lost_ || !timeline_) return;
    timeline_->wait(timeline_->last(), options_.timeout_s);
}

void Gpu::begin_one_shot() {
    if (lost_) throw VulkanError("the device was lost earlier", VK_ERROR_DEVICE_LOST, false);
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(device_->vk().vkBeginCommandBuffer(one_shot_, &begin), "vkBeginCommandBuffer");
}

void Gpu::submit_one_shot() {
    check(device_->vk().vkEndCommandBuffer(one_shot_), "vkEndCommandBuffer");
    try {
        timeline_->wait(timeline_->submit(one_shot_), options_.timeout_s);
    } catch (const compute::ComputeError& e) {
        if (!e.state_intact()) lost_ = true;
        throw;
    }
}

void Gpu::copy(VkBuffer source, VkDeviceSize source_offset, VkBuffer target, VkDeviceSize target_offset, VkDeviceSize bytes, bool to_host) {
    if (bytes == 0) return;
    run([&](VkCommandBuffer command) {
        barrier(*device_, command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT,
                VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT);
        const VkBufferCopy region{source_offset, target_offset, bytes};
        device_->vk().vkCmdCopyBuffer(command, source, target, 1, &region);
        if (to_host)
            barrier(*device_, command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
        else
            barrier(*device_, command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT,
                    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                    VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT);
    });
}

double Gpu::self_test() {
    const auto started = std::chrono::steady_clock::now();
    constexpr std::uint32_t kCount = 1000; // more than one workgroup, and not a multiple of one
    Buffer input(*device_, 16 + kCount * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "self-test input");
    Buffer output(*device_, (kCount + 1) * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Readback, "self-test output");
    auto* in = static_cast<std::uint32_t*>(input.mapped());
    in[0] = kCount;
    in[1] = in[2] = in[3] = 0;
    for (std::uint32_t i = 0; i < kCount; ++i) in[4 + i] = i + 1; // 1, 2, 3, 4, ...
    input.flush();
    std::memset(output.mapped(), 0, (kCount + 1) * 4);

    DescriptorPool pool(*device_, 1, 2);
    const auto set = pool.allocate(*pair_layout_);
    write_set(*device_, set, {input.handle(), output.handle()});
    run([&](VkCommandBuffer command) {
        const auto& vk = device_->vk();
        vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, self_test_->handle());
        vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, pair_layout_->pipeline_layout(), 0, 1, &set, 0, nullptr);
        vk.vkCmdDispatch(command, groups(kCount, workgroup_), 1, 1);
        barrier(*device_, command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
    });
    output.invalidate();

    const auto* out = static_cast<const std::uint32_t*>(output.mapped());
    for (std::uint32_t i = 0; i < kCount; ++i) {
        const auto expected = (i + 1) * 7 + 3; // 10, 17, 24, 31, ...
        if (out[i] != expected) {
            std::ostringstream message;
            message << "self-test failed: element " << i << " is " << out[i] << ", expected " << expected;
            throw std::runtime_error(message.str());
        }
    }
    const auto root = static_cast<std::uint32_t>(physics::isqrt64((std::uint64_t(1) << 40) + 12345));
    if (out[kCount] != root)
        throw std::runtime_error("self-test failed: 64-bit integer arithmetic gave " + std::to_string(out[kCount]) + ", expected " + std::to_string(root));
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
}

} // namespace dstns::vulkan
