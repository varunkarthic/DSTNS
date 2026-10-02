// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// A deliberately small PNG reader and writer: 8-bit truecolour (RGB or RGBA),
// non-interlaced, which is what terrain tiles use. Chunk CRCs and the zlib
// stream are checked, so a truncated or corrupted tile is refused rather than
// decoded into wrong elevations.

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace dstns::env {

struct RgbImage {
    std::uint32_t width{}, height{};
    std::vector<std::uint8_t> rgb;   // 3 bytes per pixel, row major, top row first
};

class PngError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

[[nodiscard]] RgbImage decode_png(const std::vector<std::uint8_t>& bytes);
/// An RGB PNG of `image` (filter type 0 on every row). Used to build test tiles.
[[nodiscard]] std::vector<std::uint8_t> encode_png(const RgbImage& image);

} // namespace dstns::env
