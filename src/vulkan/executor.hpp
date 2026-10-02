// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Command recording and submission: a command pool, a timeline semaphore that
// counts completed submissions, timestamp queries, and pipeline barriers.
// There is no vkQueueWaitIdle or vkDeviceWaitIdle in the step path: the host
// waits on the timeline value of the one submission whose results it needs.

#include "context.hpp"

#include <vector>

namespace dstns::vulkan {

class CommandPool {
public:
    CommandPool(const Device& device, std::uint32_t family);
    ~CommandPool();
    CommandPool(const CommandPool&) = delete;
    CommandPool& operator=(const CommandPool&) = delete;
    [[nodiscard]] VkCommandBuffer allocate() const;
private:
    const Device& device_;
    VkCommandPool pool_{};
};

/// A monotonic counter on the device: submission n signals value n. The host
/// waits for a value with a timeout, so a hung device is detected as a
/// failure rather than hanging the simulation.
class Timeline {
public:
    explicit Timeline(const Device& device);
    ~Timeline();
    Timeline(const Timeline&) = delete;
    Timeline& operator=(const Timeline&) = delete;
    /// Submit `command` to signal the next value; returns that value.
    std::uint64_t submit(VkCommandBuffer command);
    /// Wait until `value` is reached. Throws on device loss or timeout.
    void wait(std::uint64_t value, double timeout_s) const;
    [[nodiscard]] std::uint64_t last() const { return value_; }
private:
    const Device& device_;
    VkSemaphore semaphore_{};
    std::uint64_t value_{};
};

/// Timestamp queries. Results are read only after the timeline says the work
/// is complete, so reading them never stalls the queue.
class Timestamps {
public:
    Timestamps(const Device& device, std::uint32_t count);
    ~Timestamps();
    Timestamps(const Timestamps&) = delete;
    Timestamps& operator=(const Timestamps&) = delete;
    void reset(VkCommandBuffer command, std::uint32_t first, std::uint32_t count) const;
    void write(VkCommandBuffer command, std::uint32_t index) const;
    /// Milliseconds between consecutive queries first..first+count-1; empty if
    /// results are unavailable.
    [[nodiscard]] std::vector<double> intervals(std::uint32_t first, std::uint32_t count) const;
private:
    const Device& device_;
    VkQueryPool pool_{};
    double period_ns_{};
    std::uint64_t mask_{};
};

/// A global memory barrier. Flags are given in the classic (Vulkan 1.0)
/// encoding, which synchronization2 shares for these stages and accesses; it
/// is recorded with vkCmdPipelineBarrier2 when the device supports it.
void barrier(const Device& device, VkCommandBuffer command, VkPipelineStageFlags source_stage, VkAccessFlags source_access,
             VkPipelineStageFlags target_stage, VkAccessFlags target_access);

} // namespace dstns::vulkan
