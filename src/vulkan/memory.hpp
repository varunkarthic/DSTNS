// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Buffers and their memory. A world needs about ten buffers, created once and
// kept until the world is replaced, so each buffer takes one allocation of
// its own: far below maxMemoryAllocationCount, and simpler to reason about
// than a sub-allocator. (VulkanMemoryAllocator was considered; it pays off
// with thousands of short-lived allocations, which DSTNS does not make.)
//
// Memory types are chosen from their property flags, never from the vendor:
//   Device    DEVICE_LOCAL, preferring memory the host cannot see (on a
//             discrete GPU, host-visible device memory is the small BAR window)
//   Upload    HOST_VISIBLE | HOST_COHERENT, written by the host each step
//   Readback  HOST_VISIBLE, preferring HOST_CACHED so host reads are fast;
//             invalidated before reading when not HOST_COHERENT
// On unified-memory devices these often resolve to the same memory type.

#include "context.hpp"

#include <cstddef>
#include <optional>

namespace dstns::vulkan {

enum class MemoryUse { Device, Upload, Readback };

[[nodiscard]] std::optional<std::uint32_t> find_memory_type(const VkPhysicalDeviceMemoryProperties& memory, std::uint32_t allowed, MemoryUse use);

class Buffer {
public:
    Buffer() = default;
    Buffer(const Device& device, VkDeviceSize size, VkBufferUsageFlags usage, MemoryUse use, const char* label);
    ~Buffer();
    Buffer(Buffer&& other) noexcept;
    Buffer& operator=(Buffer&& other) noexcept;
    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;

    [[nodiscard]] VkBuffer handle() const { return buffer_; }
    [[nodiscard]] VkDeviceSize size() const { return size_; }
    [[nodiscard]] explicit operator bool() const { return buffer_ != VK_NULL_HANDLE; }
    /// Host pointer for Upload and Readback buffers; mapped for their lifetime.
    [[nodiscard]] void* mapped() const { return mapped_; }
    /// Make device writes visible to the host before reading `mapped()`.
    void invalidate() const;
    /// Make host writes visible to the device (a no-op for coherent memory).
    void flush() const;
private:
    void destroy();
    const Device* device_{};
    VkBuffer buffer_{};
    VkDeviceMemory memory_{};
    VkDeviceSize size_{};
    void* mapped_{};
    bool coherent_{true};
};

} // namespace dstns::vulkan
