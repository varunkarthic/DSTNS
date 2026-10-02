// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "memory.hpp"

#include <utility>

namespace dstns::vulkan {

std::optional<std::uint32_t> find_memory_type(const VkPhysicalDeviceMemoryProperties& memory, std::uint32_t allowed, MemoryUse use) {
    constexpr VkMemoryPropertyFlags kExcluded = VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT | VK_MEMORY_PROPERTY_PROTECTED_BIT;
    VkMemoryPropertyFlags required = 0, preferred = 0, avoided = 0;
    switch (use) {
        case MemoryUse::Device:
            required = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
            avoided = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT;
            break;
        case MemoryUse::Upload:
            required = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
            avoided = VK_MEMORY_PROPERTY_HOST_CACHED_BIT;
            break;
        case MemoryUse::Readback:
            required = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT;
            preferred = VK_MEMORY_PROPERTY_HOST_CACHED_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
            break;
    }
    std::optional<std::uint32_t> best;
    int best_score = -1;
    for (std::uint32_t i = 0; i < memory.memoryTypeCount; ++i) {
        if (!(allowed & (1u << i))) continue;
        const auto flags = memory.memoryTypes[i].propertyFlags;
        if ((flags & required) != required || (flags & kExcluded)) continue;
        int score = 0;
        if ((flags & preferred) == preferred) score += 4;
        else if (flags & preferred) score += 2;
        if (!(flags & avoided)) score += 1;
        if (score > best_score) {
            best_score = score;
            best = i;
        }
    }
    // A device-local buffer on a device that has no separate device memory
    // (software implementations) can live in any memory the device accepts.
    if (!best && use == MemoryUse::Device) {
        for (std::uint32_t i = 0; i < memory.memoryTypeCount; ++i)
            if ((allowed & (1u << i)) && !(memory.memoryTypes[i].propertyFlags & kExcluded)) return i;
    }
    return best;
}

Buffer::Buffer(const Device& device, VkDeviceSize size, VkBufferUsageFlags usage, MemoryUse use, const char* label)
    : device_(&device), size_(size) {
    const auto& vk = device.vk();
    VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    info.size = size;
    info.usage = usage;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    check(vk.vkCreateBuffer(device.handle(), &info, nullptr, &buffer_), "vkCreateBuffer");
    try {
        VkMemoryRequirements requirements{};
        vk.vkGetBufferMemoryRequirements(device.handle(), buffer_, &requirements);
        const auto type = find_memory_type(device.info().memory, requirements.memoryTypeBits, use);
        if (!type) throw VulkanError(std::string("no suitable memory type for ") + label, VK_ERROR_OUT_OF_DEVICE_MEMORY);
        const auto flags = device.info().memory.memoryTypes[*type].propertyFlags;
        coherent_ = flags & VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        VkMemoryAllocateInfo allocate{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
        allocate.allocationSize = requirements.size;
        allocate.memoryTypeIndex = *type;
        check(vk.vkAllocateMemory(device.handle(), &allocate, nullptr, &memory_), "vkAllocateMemory");
        check(vk.vkBindBufferMemory(device.handle(), buffer_, memory_, 0), "vkBindBufferMemory");
        if (use != MemoryUse::Device && (flags & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT))
            check(vk.vkMapMemory(device.handle(), memory_, 0, VK_WHOLE_SIZE, 0, &mapped_), "vkMapMemory");
        device.name(VK_OBJECT_TYPE_BUFFER, reinterpret_cast<std::uint64_t>(buffer_), label);
    } catch (...) {
        destroy();
        throw;
    }
}

Buffer::~Buffer() { destroy(); }

Buffer::Buffer(Buffer&& other) noexcept { *this = std::move(other); }

Buffer& Buffer::operator=(Buffer&& other) noexcept {
    if (this != &other) {
        destroy();
        device_ = std::exchange(other.device_, nullptr);
        buffer_ = std::exchange(other.buffer_, VK_NULL_HANDLE);
        memory_ = std::exchange(other.memory_, VK_NULL_HANDLE);
        size_ = std::exchange(other.size_, 0);
        mapped_ = std::exchange(other.mapped_, nullptr);
        coherent_ = other.coherent_;
    }
    return *this;
}

void Buffer::destroy() {
    if (!device_) return;
    const auto& vk = device_->vk();
    if (mapped_) vk.vkUnmapMemory(device_->handle(), memory_);
    if (buffer_) vk.vkDestroyBuffer(device_->handle(), buffer_, nullptr);
    if (memory_) vk.vkFreeMemory(device_->handle(), memory_, nullptr);
    buffer_ = VK_NULL_HANDLE;
    memory_ = VK_NULL_HANDLE;
    mapped_ = nullptr;
}

void Buffer::invalidate() const {
    if (coherent_ || !mapped_) return;
    VkMappedMemoryRange range{VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE};
    range.memory = memory_;
    range.size = VK_WHOLE_SIZE;
    check(device_->vk().vkInvalidateMappedMemoryRanges(device_->handle(), 1, &range), "vkInvalidateMappedMemoryRanges");
}

void Buffer::flush() const {
    if (coherent_ || !mapped_) return;
    VkMappedMemoryRange range{VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE};
    range.memory = memory_;
    range.size = VK_WHOLE_SIZE;
    check(device_->vk().vkFlushMappedMemoryRanges(device_->handle(), 1, &range), "vkFlushMappedMemoryRanges");
}

} // namespace dstns::vulkan
