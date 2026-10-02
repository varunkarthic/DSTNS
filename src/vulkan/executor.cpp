// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "executor.hpp"

#include <cmath>

namespace dstns::vulkan {

CommandPool::CommandPool(const Device& device, std::uint32_t family) : device_(device) {
    VkCommandPoolCreateInfo info{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    info.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    info.queueFamilyIndex = family;
    check(device.vk().vkCreateCommandPool(device.handle(), &info, nullptr, &pool_), "vkCreateCommandPool");
}

CommandPool::~CommandPool() { device_.vk().vkDestroyCommandPool(device_.handle(), pool_, nullptr); }

VkCommandBuffer CommandPool::allocate() const {
    VkCommandBufferAllocateInfo info{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    info.commandPool = pool_;
    info.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    info.commandBufferCount = 1;
    VkCommandBuffer command{};
    check(device_.vk().vkAllocateCommandBuffers(device_.handle(), &info, &command), "vkAllocateCommandBuffers");
    return command;
}

Timeline::Timeline(const Device& device) : device_(device) {
    VkSemaphoreTypeCreateInfo type{VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO};
    type.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
    type.initialValue = 0;
    VkSemaphoreCreateInfo info{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    info.pNext = &type;
    check(device.vk().vkCreateSemaphore(device.handle(), &info, nullptr, &semaphore_), "vkCreateSemaphore");
}

Timeline::~Timeline() { device_.vk().vkDestroySemaphore(device_.handle(), semaphore_, nullptr); }

std::uint64_t Timeline::submit(VkCommandBuffer command) {
    const auto signal = value_ + 1;
    VkTimelineSemaphoreSubmitInfo timeline{VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO};
    timeline.signalSemaphoreValueCount = 1;
    timeline.pSignalSemaphoreValues = &signal;
    VkSubmitInfo info{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    info.pNext = &timeline;
    info.commandBufferCount = 1;
    info.pCommandBuffers = &command;
    info.signalSemaphoreCount = 1;
    info.pSignalSemaphores = &semaphore_;
    check(device_.vk().vkQueueSubmit(device_.queue(), 1, &info, VK_NULL_HANDLE), "vkQueueSubmit");
    value_ = signal;
    return signal;
}

void Timeline::wait(std::uint64_t value, double timeout_s) const {
    VkSemaphoreWaitInfo info{VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO};
    info.semaphoreCount = 1;
    info.pSemaphores = &semaphore_;
    info.pValues = &value;
    const auto timeout = static_cast<std::uint64_t>(std::max(0.001, timeout_s) * 1e9);
    const auto result = device_.vk().vkWaitSemaphores(device_.handle(), &info, timeout);
    if (result == VK_TIMEOUT) {
        // The device may still be writing the candidate state: nothing on it
        // can be trusted any more.
        throw VulkanError("the device did not finish a step within the timeout", VK_TIMEOUT, false);
    }
    check(result, "vkWaitSemaphores");
}

Timestamps::Timestamps(const Device& device, std::uint32_t count) : device_(device) {
    VkQueryPoolCreateInfo info{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
    info.queryType = VK_QUERY_TYPE_TIMESTAMP;
    info.queryCount = count;
    check(device.vk().vkCreateQueryPool(device.handle(), &info, nullptr, &pool_), "vkCreateQueryPool");
    period_ns_ = device.info().properties.limits.timestampPeriod;
    const auto bits = device.info().timestamp_bits;
    mask_ = bits >= 64 ? ~0ull : ((1ull << bits) - 1);
}

Timestamps::~Timestamps() { device_.vk().vkDestroyQueryPool(device_.handle(), pool_, nullptr); }

void Timestamps::reset(VkCommandBuffer command, std::uint32_t first, std::uint32_t count) const {
    device_.vk().vkCmdResetQueryPool(command, pool_, first, count);
}

void Timestamps::write(VkCommandBuffer command, std::uint32_t index) const {
    device_.vk().vkCmdWriteTimestamp(command, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, pool_, index);
}

std::vector<double> Timestamps::intervals(std::uint32_t first, std::uint32_t count) const {
    std::vector<std::uint64_t> raw(count);
    const auto result = device_.vk().vkGetQueryPoolResults(device_.handle(), pool_, first, count, raw.size() * sizeof(std::uint64_t),
                                                           raw.data(), sizeof(std::uint64_t), VK_QUERY_RESULT_64_BIT);
    if (result != VK_SUCCESS || count < 2) return {};
    std::vector<double> out;
    for (std::uint32_t i = 1; i < count; ++i) {
        const auto delta = ((raw[i] & mask_) - (raw[i - 1] & mask_)) & mask_;
        out.push_back(double(delta) * period_ns_ / 1e6);
    }
    return out;
}

void barrier(const Device& device, VkCommandBuffer command, VkPipelineStageFlags source_stage, VkAccessFlags source_access,
             VkPipelineStageFlags target_stage, VkAccessFlags target_access) {
    const auto& vk = device.vk();
    if (device.synchronization2()) {
        VkMemoryBarrier2 memory{VK_STRUCTURE_TYPE_MEMORY_BARRIER_2};
        memory.srcStageMask = source_stage;
        memory.srcAccessMask = source_access;
        memory.dstStageMask = target_stage;
        memory.dstAccessMask = target_access;
        VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
        dependency.memoryBarrierCount = 1;
        dependency.pMemoryBarriers = &memory;
        if (vk.vkCmdPipelineBarrier2) vk.vkCmdPipelineBarrier2(command, &dependency);
        else vk.vkCmdPipelineBarrier2KHR(command, &dependency);
        return;
    }
    VkMemoryBarrier memory{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    memory.srcAccessMask = source_access;
    memory.dstAccessMask = target_access;
    vk.vkCmdPipelineBarrier(command, source_stage, target_stage, 0, 1, &memory, 0, nullptr, 0, nullptr);
}

} // namespace dstns::vulkan
