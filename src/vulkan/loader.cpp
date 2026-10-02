// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "loader.hpp"

#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <sstream>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

namespace dstns::vulkan {
namespace {

std::filesystem::path executable_directory() {
#if defined(__APPLE__)
    char buffer[4096];
    std::uint32_t size = sizeof(buffer);
    if (_NSGetExecutablePath(buffer, &size) == 0) return std::filesystem::path(buffer).parent_path();
#elif defined(__linux__)
    std::error_code error;
    auto self = std::filesystem::read_symlink("/proc/self/exe", error);
    if (!error) return self.parent_path();
#endif
    return {};
}

std::vector<std::string> candidates(const std::string& explicit_path) {
    std::vector<std::string> list;
    if (!explicit_path.empty()) list.push_back(explicit_path);
    const auto here = executable_directory();
#if defined(__APPLE__)
    // The Khronos loader first: it finds MoltenVK and any other driver through
    // their manifests, and it is what loads the validation layers.
    list.insert(list.end(), {"libvulkan.1.dylib", "libvulkan.dylib"});
    if (const char* sdk = std::getenv("VULKAN_SDK"); sdk && *sdk) list.push_back(std::string(sdk) + "/lib/libvulkan.1.dylib");
    list.insert(list.end(), {"/opt/homebrew/lib/libvulkan.1.dylib", "/usr/local/lib/libvulkan.1.dylib"});
    if (!here.empty()) {
        list.push_back((here / "libvulkan.1.dylib").string());
        list.push_back((here / "../lib/libvulkan.1.dylib").lexically_normal().string());
    }
    // Then MoltenVK on its own: a complete Vulkan implementation for Apple
    // GPUs, usable without a loader (but without layers).
    list.insert(list.end(), {"libMoltenVK.dylib", "/opt/homebrew/lib/libMoltenVK.dylib", "/usr/local/lib/libMoltenVK.dylib"});
    if (!here.empty()) {
        list.push_back((here / "libMoltenVK.dylib").string());
        list.push_back((here / "../lib/libMoltenVK.dylib").lexically_normal().string());
    }
#else
    list.insert(list.end(), {"libvulkan.so.1", "libvulkan.so"});
    if (!here.empty()) list.push_back((here / "libvulkan.so.1").string());
#endif
    return list;
}

Library open(const std::string& explicit_path) {
    Library library;
    if (!explicit_path.empty()) {
        std::error_code error;
        if (!std::filesystem::is_regular_file(explicit_path, error)) {
            library.error = "DSTNS_VULKAN_LIBRARY does not name a file";
            return library;
        }
    }
    for (const auto& candidate : candidates(explicit_path)) {
        library.tried.push_back(candidate);
        void* handle = dlopen(candidate.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (!handle) continue;
        auto* entry = reinterpret_cast<PFN_vkGetInstanceProcAddr>(dlsym(handle, "vkGetInstanceProcAddr"));
        if (!entry) {
            dlclose(handle);
            continue;
        }
        // The only process-wide Vulkan state: the loader's entry point, from
        // which every instance builds its own dispatch table.
        volkInitializeCustom(entry);
        library.loaded = true;
        library.path = candidate;
        library.moltenvk_direct = candidate.find("MoltenVK") != std::string::npos;
        return library;
    }
    std::ostringstream message;
    message << "no Vulkan loader or driver library was found";
#if defined(__APPLE__)
    message << " (install MoltenVK and the Vulkan loader, e.g. brew install molten-vk vulkan-loader)";
#else
    message << " (install the Vulkan loader, e.g. libvulkan1, and a Vulkan driver for the GPU)";
#endif
    library.error = message.str();
    return library;
}

} // namespace

const Library& load_library(const std::string& explicit_path) {
    static std::mutex mutex;
    static Library library;
    static bool attempted = false;
    std::lock_guard lock(mutex);
    if (!attempted) {
        attempted = true;
        library = open(explicit_path);
    }
    return library;
}

} // namespace dstns::vulkan
