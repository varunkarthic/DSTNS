// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Instance, physical-device discovery and selection, and the logical device.
// Compute only: no surface, no swapchain, no graphics queue requirement.

#include "loader.hpp"
#include "vk.hpp"

#include "dstns/compute/options.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace dstns::vulkan {

/// Validation messages seen by the debug messenger, counted per severity so
/// that tests can require none.
struct ValidationCounters {
    std::atomic<std::uint32_t> errors{0}, warnings{0};
    compute::LogSink log;
};

class Instance {
public:
    Instance(const compute::ComputeOptions& options, const compute::LogSink& log);
    ~Instance();
    Instance(const Instance&) = delete;
    Instance& operator=(const Instance&) = delete;
    [[nodiscard]] VkInstance handle() const { return instance_; }
    [[nodiscard]] const VolkInstanceTable& vk() const { return table_; }
    [[nodiscard]] std::uint32_t api_version() const { return api_version_; }
    [[nodiscard]] bool validation() const { return validation_; }
    [[nodiscard]] bool debug_utils() const { return debug_utils_; }
    [[nodiscard]] const Library& library() const { return *library_; }
    [[nodiscard]] const ValidationCounters& counters() const { return *counters_; }
private:
    const Library* library_{};
    VkInstance instance_{};
    VolkInstanceTable table_{};
    VkDebugUtilsMessengerEXT messenger_{};
    std::uint32_t api_version_{};
    bool validation_{}, debug_utils_{};
    std::unique_ptr<ValidationCounters> counters_;
};

/// Everything selection needs to know about one physical device.
struct DeviceInfo {
    VkPhysicalDevice handle{};
    std::uint32_t index{};
    VkPhysicalDeviceProperties properties{};
    VkPhysicalDeviceMemoryProperties memory{};
    std::string name, uuid, driver_name, driver_info;
    VkDriverId driver_id{};
    std::uint64_t device_local_bytes{};
    std::uint64_t max_allocation{};
    bool int64{}, timeline{}, synchronization2{}, synchronization2_core{}, portability_subset{}, memory_budget{};
    bool software{}, unified_memory{};
    bool timestamps{};
    int queue_family{-1};
    bool dedicated_compute{};
    std::uint32_t timestamp_bits{};
    bool usable{};
    std::string unusable_reason;
    int score{};
    [[nodiscard]] bool moltenvk() const;
    [[nodiscard]] std::string type_name() const;
    [[nodiscard]] std::string vendor_name() const;
    [[nodiscard]] std::string driver_version_string() const;
    [[nodiscard]] nlohmann::json json() const;
};

/// Enumerate every physical device and judge whether DSTNS can use it.
[[nodiscard]] std::vector<DeviceInfo> enumerate_devices(const Instance& instance, bool allow_software);

/// The device to use: the one DSTNS_GPU_DEVICE names (by index, UUID or name
/// substring), otherwise the highest-scoring usable device, ties broken by
/// UUID so the choice does not depend on enumeration order. Software
/// implementations are chosen only when allowed or named explicitly. Returns
/// nullptr with `reason` set when nothing is suitable.
[[nodiscard]] const DeviceInfo* select_device(const std::vector<DeviceInfo>& devices, const compute::ComputeOptions& options, std::string& reason);

class Device {
public:
    Device(const Instance& instance, const DeviceInfo& info);
    ~Device();
    Device(const Device&) = delete;
    Device& operator=(const Device&) = delete;
    [[nodiscard]] VkDevice handle() const { return device_; }
    [[nodiscard]] const VolkDeviceTable& vk() const { return table_; }
    [[nodiscard]] VkQueue queue() const { return queue_; }
    [[nodiscard]] const DeviceInfo& info() const { return info_; }
    [[nodiscard]] const Instance& instance() const { return instance_; }
    [[nodiscard]] bool synchronization2() const { return synchronization2_; }
    /// Name an object for validation messages and GPU debuggers.
    void name(VkObjectType type, std::uint64_t handle, const char* label) const;
    /// Bytes of device-local memory this process may still allocate, from
    /// VK_EXT_memory_budget when available, else the heap size.
    [[nodiscard]] std::uint64_t memory_budget() const;
private:
    const Instance& instance_;
    DeviceInfo info_;
    VkDevice device_{};
    VolkDeviceTable table_{};
    VkQueue queue_{};
    bool synchronization2_{};
};

} // namespace dstns::vulkan
