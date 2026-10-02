// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The physics step as C++. The definitions live in shaders/include/
// dstns_physics.h, which the Vulkan compute shaders include as GLSL; this
// header gives them C++ types and a namespace. Nothing else may define the
// step: one source is what makes the backends agree bit for bit.

#include <cstdint>

namespace dstns::physics {

using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i64 = std::int64_t;

// Forced inline: the step functions take small structs by value, which costs
// copies and calls in a per-edge loop unless the compiler flattens them.
#if defined(__GNUC__) || defined(__clang__)
#define DSTNS_FN inline __attribute__((always_inline))
#else
#define DSTNS_FN inline
#endif
#include "dstns_physics.h"
#undef DSTNS_FN

} // namespace dstns::physics
