// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Linked instead of the Vulkan module when DSTNS is built without Vulkan
// support, so the rest of the system needs no conditional compilation.

#include "dstns/compute/field.hpp"
#include "dstns/compute/vulkan.hpp"

namespace dstns::compute {

bool vulkan_compiled() { return false; }

std::unique_ptr<IComputeBackend> create_vulkan_backend(const ComputeOptions&, const LogSink&, std::string& reason) {
    reason = "this build does not include the Vulkan backend (configure with -DDSTNS_ENABLE_VULKAN=ON)";
    return nullptr;
}

nlohmann::json vulkan_diagnostics(const ComputeOptions&) {
    return {{"compiled", false}, {"available", false},
            {"reason", "this build does not include the Vulkan backend (configure with -DDSTNS_ENABLE_VULKAN=ON)"},
            {"devices", nlohmann::json::array()}};
}

nlohmann::json vulkan_shader_bundle() { return nullptr; }

std::unique_ptr<FieldSolver> create_vulkan_field_solver(const ComputeOptions&, const LogSink&, std::string& reason) {
    reason = "this build does not include the Vulkan backend";
    return nullptr;
}

} // namespace dstns::compute
