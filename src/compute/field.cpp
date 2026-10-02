// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/compute/field.hpp"

#include "dstns/compute/physics.hpp"

namespace dstns::compute {
namespace fields {
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i64 = std::int64_t;
#define DSTNS_FN inline
#include "dstns_fields.h"
#undef DSTNS_FN
} // namespace fields

void diffuse(Field2D& field, std::uint32_t rate_q16, std::uint32_t iterations) {
    const auto w = field.width, h = field.height;
    std::vector<std::uint32_t> next(field.cells.size());
    for (std::uint32_t k = 0; k < iterations; ++k) {
        const auto& c = field.cells;
        for (std::uint32_t y = 0; y < h; ++y)
            for (std::uint32_t x = 0; x < w; ++x) {
                const auto i = std::size_t(y) * w + x;
                const auto centre = c[i];
                next[i] = fields::diffuse_cell(centre, y > 0 ? c[i - w] : centre, y + 1 < h ? c[i + w] : centre,
                                               x + 1 < w ? c[i + 1] : centre, x > 0 ? c[i - 1] : centre, rate_q16);
            }
        field.cells.swap(next);
    }
}

} // namespace dstns::compute
