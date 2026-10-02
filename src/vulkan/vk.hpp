// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Common ground for the Vulkan module: the Vulkan headers through volk (no
// link-time dependency on a Vulkan library, which is loaded at run time), and
// the translation of VkResult into exceptions at this module's boundary.
//
// Function pointers live in per-instance and per-device tables, never in
// process-wide globals, so two devices or a diagnostic probe beside a running
// backend cannot interfere.

#include "dstns/compute/backend.hpp"

#include <volk.h>

#include <string>

namespace dstns::vulkan {

[[nodiscard]] const char* result_name(VkResult result);

/// A failed Vulkan call. Device loss means the device's memory, including the
/// committed simulation state, is gone.
class VulkanError : public compute::ComputeError {
public:
    VulkanError(const std::string& operation, VkResult result, bool state_intact = true)
        : compute::ComputeError(operation + " failed: " + result_name(result),
                                state_intact && result != VK_ERROR_DEVICE_LOST, result == VK_ERROR_DEVICE_LOST),
          result_(result) {}
    [[nodiscard]] VkResult result() const { return result_; }
private:
    VkResult result_;
};

inline void check(VkResult result, const char* operation) {
    if (result != VK_SUCCESS) throw VulkanError(operation, result);
}

/// "1.3.280" from a packed Vulkan version.
[[nodiscard]] std::string version_string(std::uint32_t version);

} // namespace dstns::vulkan
