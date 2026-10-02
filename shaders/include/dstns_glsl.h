// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// GLSL prelude for the DSTNS compute shaders: the integer types the shared
// physics definitions are written in, then the definitions themselves.
// Floating point is not used anywhere in these shaders.

#extension GL_EXT_shader_explicit_arithmetic_types_int64 : require

#define u32 uint
#define u64 uint64_t
#define i64 int64_t
#define DSTNS_FN

#include "dstns_physics.h"

// The workgroup size is a specialisation constant, chosen per device at
// pipeline creation from its limits, so one SPIR-V module serves every vendor.
layout(local_size_x_id = 0) in;

// Reinterpret a stored word as a signed 32-bit value, widened.
i64 signed_word(u32 word) { return i64(int(word)); }
