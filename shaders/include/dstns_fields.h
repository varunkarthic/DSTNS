// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Structured-grid kernels, written once for every compute backend, under the
// same rules as dstns_physics.h: integers only, explicit conversions, values in
// and values out. A field is one 32-bit word per cell on a uniform grid, row
// major. These are the building blocks of the spatial models that sit beside
// the road network: standing water on a terrain model, rain fields, and later
// wind and pressure.

// One explicit diffusion step for a non-negative field (for example water
// depth in Q30): next = c + rate * (n + s + e + w - 4c), rate in Q16 (stable
// for rate <= 0.25). Edges are zero-flux: a missing neighbour is the cell
// itself. The product is floored, so the result is the same on every device.
DSTNS_FN u32 diffuse_cell(u32 centre, u32 north, u32 south, u32 east, u32 west, u32 rate_q16) {
    i64 laplacian = i64(north) + i64(south) + i64(east) + i64(west) - i64(4) * i64(centre);
    i64 next = i64(centre) + ((i64(rate_q16) * laplacian) >> u64(16u));
    if (next < i64(0)) return u32(0u);
    if (next > i64(4294967295u)) return u32(4294967295u);
    return u32(next);
}
