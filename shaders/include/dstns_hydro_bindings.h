// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The buffers every surface-water pass shares, in one descriptor set layout.
// Mirrors HydrologyGrid and HydrologyState in src/environment/hydrology.cpp.
//
// Parameters (u32 words):
//   0 width  1 height  2..3 a_q20  4..5 k_q32  6..7 c_q24  8..9 hmin  10..11 theta
//   12 edges  (road summaries)

layout(std430, set = 0, binding = 0) readonly buffer Params { uint params[]; };
layout(std430, set = 0, binding = 1) readonly buffer Bed { int z_q16[]; };
layout(std430, set = 0, binding = 2) readonly buffer Flags { uint flags[]; };
layout(std430, set = 0, binding = 3) buffer Depth { int depth[]; };
layout(std430, set = 0, binding = 4) buffer FaceX { int qx[]; };
layout(std430, set = 0, binding = 5) buffer FaceY { int qy[]; };
layout(std430, set = 0, binding = 6) buffer FaceXPrev { int qx_prev[]; };
layout(std430, set = 0, binding = 7) buffer FaceYPrev { int qy_prev[]; };
layout(std430, set = 0, binding = 8) buffer Limiter { int limiter[]; };
layout(std430, set = 0, binding = 9) buffer Boundary { int boundary_out[]; };
layout(std430, set = 0, binding = 10) buffer Sea { int sea_out[]; };
layout(std430, set = 0, binding = 11) readonly buffer Rain { int rain[]; };
layout(std430, set = 0, binding = 12) readonly buffer Evaporation { int evaporation[]; };
layout(std430, set = 0, binding = 13) readonly buffer Infiltration { int infiltration[]; };
layout(std430, set = 0, binding = 14) buffer Evaporated { int evaporated[]; };
layout(std430, set = 0, binding = 15) buffer Infiltrated { int infiltrated[]; };
layout(std430, set = 0, binding = 16) buffer Rows { uint rows[]; };
layout(std430, set = 0, binding = 17) readonly buffer RoadOffsets { uint road_offsets[]; };
layout(std430, set = 0, binding = 18) readonly buffer RoadCells { uint road_cells[]; };
layout(std430, set = 0, binding = 19) buffer Roads { int roads[]; };

const uint HYD_BINDINGS = 20u;
// Words per row in the reduction output: stored, boundary, sea, evaporated,
// infiltrated (each i64 as two words), h_max, wet, flooded.
const uint HYD_ROW_WORDS = 16u;

uint grid_w() { return params[0]; }
uint grid_h() { return params[1]; }
i64 param64(uint at) { return i64(uint64_t(params[at]) | (uint64_t(params[at + 1u]) << 32)); }
i64 cell_z(uint i, uint j) { return i64(z_q16[j * grid_w() + i]) << 8; }
i64 cell_h(uint i, uint j) { return i64(depth[j * grid_w() + i]); }
int clamp32(i64 v) { return int(v < i64(-2147483648) ? i64(-2147483648) : (v > i64(2147483647) ? i64(2147483647) : v)); }
