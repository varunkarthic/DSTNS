// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The Vulkan backend, seen from outside the Vulkan module. Nothing here
// mentions a Vulkan type: the engine, the API and the tests depend on the
// compute contract, and only src/vulkan/ includes Vulkan headers. A build
// without Vulkan support links a stub that reports why it is unavailable.

#include "dstns/compute/backend.hpp"
#include "dstns/compute/options.hpp"

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

namespace dstns::compute {

/// Whether this binary contains the Vulkan backend at all.
[[nodiscard]] bool vulkan_compiled();

/// Bring up Vulkan on the device the options select and verify it with a
/// compute self-test. Returns nullptr, with `reason` set, when Vulkan cannot
/// be used: no loader, no suitable device, a failed self-test.
[[nodiscard]] std::unique_ptr<IComputeBackend> create_vulkan_backend(const ComputeOptions& options, const LogSink& log, std::string& reason);

/// Everything the GPU diagnostics report: the loader, every device and its
/// properties, which device would be selected and why, and for each usable
/// device a real allocation, pipeline, dispatch and readback. Never throws.
[[nodiscard]] nlohmann::json vulkan_diagnostics(const ComputeOptions& options);

/// SHA-256 of the embedded SPIR-V bundle and the compiler that produced it.
[[nodiscard]] nlohmann::json vulkan_shader_bundle();

} // namespace dstns::compute
