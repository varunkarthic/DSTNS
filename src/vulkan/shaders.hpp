// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The compiled compute shaders, embedded in the binary at build time
// (cmake/EmbedSpirv.cmake generates the definitions). No shader is compiled at
// run time and no shader file is read from disk.

#include <cstddef>
#include <cstdint>

namespace dstns::vulkan::shaders {

struct Binary {
    const char* name;
    const std::uint32_t* words;
    std::size_t word_count;
    const char* spirv_sha256;  // of the SPIR-V
    const char* source_sha256; // of the GLSL and everything it includes
};

extern const Binary kShaders[];
extern const std::size_t kShaderCount;
/// SHA-256 over every shader's SPIR-V hash, in name order: one identity for
/// the bundle, reported in system information and keyed into the pipeline cache.
extern const char* const kBundleSha256;
/// The compiler that produced the SPIR-V, or "precompiled" when the build
/// used the SPIR-V committed to the repository.
extern const char* const kCompiler;

/// The shader called `name`, or nullptr.
[[nodiscard]] const Binary* find(const char* name);

} // namespace dstns::vulkan::shaders
