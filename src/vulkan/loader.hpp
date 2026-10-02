// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "vk.hpp"

#include <string>
#include <vector>

namespace dstns::vulkan {

/// The Vulkan library this process loaded: the Khronos loader where one is
/// installed (it finds every driver, and the validation layers), otherwise
/// MoltenVK directly on macOS. Loaded once per process; the library cannot be
/// unloaded while any Vulkan object exists, so it is not.
struct Library {
    bool loaded{};
    std::string path;          // what was opened, for diagnostics
    bool moltenvk_direct{};    // MoltenVK without a loader: no layers
    std::string error;
    std::vector<std::string> tried;
};

/// Load (or return the already loaded) Vulkan library. `explicit_path`, from
/// DSTNS_VULKAN_LIBRARY, is tried first and must be an existing regular file.
[[nodiscard]] const Library& load_library(const std::string& explicit_path);

} // namespace dstns::vulkan
