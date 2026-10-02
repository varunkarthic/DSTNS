// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/compute/options.hpp"
#include "dstns/compute/backend.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <stdexcept>

namespace dstns::compute {
namespace {
std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

const char* env(const char* name) {
    const char* value = std::getenv(name);
    return value && *value ? value : nullptr;
}

std::uint32_t parse_count(const std::string& name, const std::string& value, std::uint32_t maximum) {
    if (value.empty() || value.size() > 10 || value.find_first_not_of("0123456789") != std::string::npos)
        throw std::invalid_argument(name + " must be a whole number");
    const auto parsed = std::stoull(value);
    if (parsed > maximum) throw std::invalid_argument(name + " must be at most " + std::to_string(maximum));
    return static_cast<std::uint32_t>(parsed);
}
} // namespace

const char* to_string(BackendType type) {
    switch (type) {
        case BackendType::Cpu: return "cpu";
        case BackendType::Vulkan: return "vulkan";
    }
    return "cpu";
}

const char* to_string(BackendHealth health) {
    switch (health) {
        case BackendHealth::Unavailable: return "unavailable";
        case BackendHealth::Disabled: return "disabled";
        case BackendHealth::Available: return "available";
        case BackendHealth::Active: return "active";
        case BackendHealth::Degraded: return "degraded";
        case BackendHealth::Failed: return "failed";
    }
    return "unavailable";
}

const char* to_string(BackendPreference preference) {
    switch (preference) {
        case BackendPreference::Auto: return "auto";
        case BackendPreference::Cpu: return "cpu";
        case BackendPreference::Vulkan: return "vulkan";
    }
    return "auto";
}

BackendPreference parse_preference(const std::string& text) {
    const auto value = lower(text);
    if (value == "auto") return BackendPreference::Auto;
    if (value == "cpu") return BackendPreference::Cpu;
    if (value == "vulkan" || value == "gpu") return BackendPreference::Vulkan;
    throw std::invalid_argument("compute backend must be auto, cpu or vulkan");
}

bool parse_flag(const std::string& name, const std::string& text) {
    const auto value = lower(text);
    if (value == "1" || value == "true" || value == "on" || value == "yes") return true;
    if (value == "0" || value == "false" || value == "off" || value == "no") return false;
    throw std::invalid_argument(name + " must be 0 or 1");
}

void ComputeOptions::apply_environment() {
    if (const auto* v = env("DSTNS_COMPUTE_BACKEND")) backend = parse_preference(v);
    if (const auto* v = env("DSTNS_ALLOW_VULKAN")) allow_vulkan = parse_flag("DSTNS_ALLOW_VULKAN", v);
    if (const auto* v = env("DSTNS_ALLOW_SOFTWARE_VULKAN")) allow_software_vulkan = parse_flag("DSTNS_ALLOW_SOFTWARE_VULKAN", v);
    if (const auto* v = env("DSTNS_REQUIRE_VULKAN")) require_vulkan = parse_flag("DSTNS_REQUIRE_VULKAN", v);
    if (const auto* v = env("DSTNS_COMPUTE_VERIFY")) verify = parse_flag("DSTNS_COMPUTE_VERIFY", v);
    if (const auto* v = env("DSTNS_VULKAN_VALIDATION")) validation = parse_flag("DSTNS_VULKAN_VALIDATION", v);
    if (const auto* v = env("DSTNS_COMPUTE_CALIBRATE")) calibrate = parse_flag("DSTNS_COMPUTE_CALIBRATE", v);
    if (const auto* v = env("DSTNS_GPU_DEVICE")) {
        device = v;
        if (device.size() > 256) throw std::invalid_argument("DSTNS_GPU_DEVICE is too long");
    }
    if (const auto* v = env("DSTNS_GPU_WORKGROUP")) {
        workgroup_size = parse_count("DSTNS_GPU_WORKGROUP", v, 1024);
        if (workgroup_size != 0 && workgroup_size != 64 && workgroup_size != 128 && workgroup_size != 256)
            throw std::invalid_argument("DSTNS_GPU_WORKGROUP must be 64, 128 or 256");
    }
    if (const auto* v = env("DSTNS_COMPUTE_MIN_NODES")) min_nodes = parse_count("DSTNS_COMPUTE_MIN_NODES", v, 100'000'000);
    if (const auto* v = env("DSTNS_COMPUTE_MIN_EDGES")) min_edges = parse_count("DSTNS_COMPUTE_MIN_EDGES", v, 100'000'000);
    if (const auto* v = env("DSTNS_COMPUTE_THREADS")) cpu_threads = parse_count("DSTNS_COMPUTE_THREADS", v, 256);
    if (const auto* v = env("DSTNS_VULKAN_CACHE_DIR")) cache_dir = v;
    if (const auto* v = env("DSTNS_VULKAN_LIBRARY")) library = v;
}

std::map<std::string, std::string> ComputeOptions::describe() const {
    return {
        {"requested_backend", to_string(backend)},
        {"allow_vulkan", allow_vulkan ? "true" : "false"},
        {"allow_software_vulkan", allow_software_vulkan ? "true" : "false"},
        {"require_vulkan", require_vulkan ? "true" : "false"},
        {"verification", verify ? "true" : "false"},
        {"validation_layers", validation ? "true" : "false"},
        {"device", device},
        {"min_nodes", std::to_string(min_nodes)},
        {"min_edges", std::to_string(min_edges)},
        {"calibrate", calibrate ? "true" : "false"},
    };
}

} // namespace dstns::compute
