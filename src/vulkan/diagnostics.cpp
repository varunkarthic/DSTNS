// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The Vulkan module's public entry points: creating the backend, and the GPU
// diagnostics that test every device for real rather than trusting that a
// library exists.

#include "backend.hpp"

#include "dstns/compute/vulkan.hpp"

#include <chrono>
#include <filesystem>

namespace dstns::compute {

bool vulkan_compiled() { return true; }

std::unique_ptr<IComputeBackend> create_vulkan_backend(const ComputeOptions& options, const LogSink& log, std::string& reason) {
    try {
        return std::make_unique<vulkan::VulkanComputeBackend>(options, log);
    } catch (const std::exception& e) {
        reason = e.what();
    } catch (...) {
        reason = "unknown error while initialising Vulkan";
    }
    return nullptr;
}

nlohmann::json vulkan_shader_bundle() {
    auto list = nlohmann::json::array();
    for (std::size_t i = 0; i < vulkan::shaders::kShaderCount; ++i) {
        const auto& s = vulkan::shaders::kShaders[i];
        list.push_back({{"name", s.name}, {"spirv_sha256", s.spirv_sha256}, {"source_sha256", s.source_sha256}, {"bytes", s.word_count * 4}});
    }
    return {{"sha256", vulkan::shaders::kBundleSha256}, {"compiler", vulkan::shaders::kCompiler}, {"shaders", list}};
}

nlohmann::json vulkan_diagnostics(const ComputeOptions& options) {
    nlohmann::json report{{"compiled", true}, {"available", false}, {"devices", nlohmann::json::array()}, {"shader_bundle", vulkan_shader_bundle()}};
    std::unique_ptr<vulkan::Instance> instance;
    try {
        instance = std::make_unique<vulkan::Instance>(options, LogSink{});
    } catch (const std::exception& e) {
        const auto& library = vulkan::load_library(options.library);
        report["loader"] = {{"loaded", library.loaded}, {"library", std::filesystem::path(library.path).filename().string()},
                            {"error", library.error}};
        report["reason"] = e.what();
        return report;
    }
    const auto& library = instance->library();
    report["loader"] = {{"loaded", true}, {"library", std::filesystem::path(library.path).filename().string()},
                        {"moltenvk_direct", library.moltenvk_direct}, {"instance_version", vulkan::version_string(instance->api_version())},
                        {"validation_layers", instance->validation()}};
    std::vector<vulkan::DeviceInfo> devices;
    try {
        devices = vulkan::enumerate_devices(*instance, options.allow_software_vulkan);
    } catch (const std::exception& e) {
        report["reason"] = e.what();
        return report;
    }
    std::string reason;
    const auto* chosen = vulkan::select_device(devices, options, reason);
    report["selected"] = chosen ? nlohmann::json{{"index", chosen->index}, {"name", chosen->name}} : nlohmann::json(nullptr);
    if (!chosen) report["reason"] = reason;
    instance.reset();

    // Bring each usable device all the way up: device, buffers, every
    // pipeline, a dispatch and a checked readback.
    for (const auto& d : devices) {
        auto entry = d.json();
        if (d.usable) {
            auto probe = options;
            probe.device = std::to_string(d.index);
            probe.allow_software_vulkan = true;
            probe.fault = {};
            const auto started = std::chrono::steady_clock::now();
            try {
                vulkan::VulkanComputeBackend backend(probe, LogSink{});
                const auto caps = backend.capabilities();
                entry["self_test"] = {{"passed", true}, {"pipelines", 4}, {"workgroup_size", caps.workgroup_size},
                                      {"pipeline_cache", caps.pipeline_cache},
                                      {"seconds", std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count()}};
            } catch (const std::exception& e) {
                entry["self_test"] = {{"passed", false}, {"error", e.what()}};
            }
        }
        entry["selected"] = chosen && chosen->index == d.index;
        report["devices"].push_back(entry);
    }
    if (chosen) {
        for (const auto& entry : report["devices"])
            if (entry["selected"].get<bool>()) report["available"] = entry.contains("self_test") && entry["self_test"]["passed"].get<bool>();
    }
    return report;
}

} // namespace dstns::compute
