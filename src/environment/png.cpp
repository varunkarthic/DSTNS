// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/environment/png.hpp"

#include <array>
#include <cstdlib>
#include <cstring>
#include <zlib.h>

namespace dstns::env {
namespace {

constexpr std::array<std::uint8_t, 8> kSignature{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
constexpr std::uint32_t kMaxSide = 8192;

std::uint32_t be32(const std::uint8_t* p) {
    return (std::uint32_t(p[0]) << 24) | (std::uint32_t(p[1]) << 16) | (std::uint32_t(p[2]) << 8) | p[3];
}
void put32(std::vector<std::uint8_t>& out, std::uint32_t v) {
    for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<std::uint8_t>(v >> s));
}

std::uint8_t paeth(int a, int b, int c) {
    const int p = a + b - c, pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c);
    return static_cast<std::uint8_t>(pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
}

} // namespace

RgbImage decode_png(const std::vector<std::uint8_t>& bytes) {
    if (bytes.size() < kSignature.size() + 12 || std::memcmp(bytes.data(), kSignature.data(), kSignature.size()) != 0)
        throw PngError("not a PNG file");
    std::size_t at = kSignature.size();
    std::uint32_t width = 0, height = 0, channels = 0;
    bool header = false, end = false;
    std::vector<std::uint8_t> compressed;
    while (at + 12 <= bytes.size() && !end) {
        const auto length = be32(&bytes[at]);
        if (length > bytes.size() - at - 12) throw PngError("truncated PNG chunk");
        const auto* type = &bytes[at + 4];
        const auto* data = &bytes[at + 8];
        const auto crc = be32(&bytes[at + 8 + length]);
        if (static_cast<std::uint32_t>(crc32(0L, type, length + 4)) != crc) throw PngError("PNG chunk CRC mismatch");
        if (std::memcmp(type, "IHDR", 4) == 0) {
            if (length != 13) throw PngError("bad PNG header");
            width = be32(data);
            height = be32(data + 4);
            const auto depth = data[8], colour = data[9], interlace = data[12];
            if (depth != 8 || (colour != 2 && colour != 6) || interlace != 0 || data[10] != 0 || data[11] != 0)
                throw PngError("unsupported PNG: only 8-bit RGB or RGBA, non-interlaced");
            if (!width || !height || width > kMaxSide || height > kMaxSide) throw PngError("PNG dimensions out of range");
            channels = colour == 2 ? 3 : 4;
            header = true;
        } else if (std::memcmp(type, "IDAT", 4) == 0) {
            compressed.insert(compressed.end(), data, data + length);
        } else if (std::memcmp(type, "IEND", 4) == 0) {
            end = true;
        }
        at += 12 + length;
    }
    if (!header || !end || compressed.empty()) throw PngError("incomplete PNG");
    const std::size_t stride = std::size_t(width) * channels;
    std::vector<std::uint8_t> raw((stride + 1) * height);
    uLongf produced = static_cast<uLongf>(raw.size());
    if (uncompress(raw.data(), &produced, compressed.data(), static_cast<uLong>(compressed.size())) != Z_OK || produced != raw.size())
        throw PngError("corrupt PNG image data");

    RgbImage image{width, height, std::vector<std::uint8_t>(std::size_t(width) * height * 3)};
    std::vector<std::uint8_t> previous(stride, 0), current(stride);
    for (std::uint32_t y = 0; y < height; ++y) {
        const auto* row = &raw[y * (stride + 1)];
        const auto filter = row[0];
        for (std::size_t x = 0; x < stride; ++x) {
            const int a = x >= channels ? current[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
            int predictor = 0;
            switch (filter) {
                case 0: predictor = 0; break;
                case 1: predictor = a; break;
                case 2: predictor = b; break;
                case 3: predictor = (a + b) / 2; break;
                case 4: predictor = paeth(a, b, c); break;
                default: throw PngError("unknown PNG filter");
            }
            current[x] = static_cast<std::uint8_t>(row[1 + x] + predictor);
        }
        for (std::uint32_t x = 0; x < width; ++x)
            for (int k = 0; k < 3; ++k) image.rgb[(std::size_t(y) * width + x) * 3 + k] = current[std::size_t(x) * channels + k];
        previous.swap(current);
    }
    return image;
}

std::vector<std::uint8_t> encode_png(const RgbImage& image) {
    std::vector<std::uint8_t> raw;
    raw.reserve((std::size_t(image.width) * 3 + 1) * image.height);
    for (std::uint32_t y = 0; y < image.height; ++y) {
        raw.push_back(0);
        const auto* row = &image.rgb[std::size_t(y) * image.width * 3];
        raw.insert(raw.end(), row, row + std::size_t(image.width) * 3);
    }
    uLongf size = compressBound(static_cast<uLong>(raw.size()));
    std::vector<std::uint8_t> compressed(size);
    if (compress(compressed.data(), &size, raw.data(), static_cast<uLong>(raw.size())) != Z_OK) throw PngError("compression failed");
    compressed.resize(size);

    std::vector<std::uint8_t> out(kSignature.begin(), kSignature.end());
    const auto chunk = [&](const char* type, const std::vector<std::uint8_t>& data) {
        put32(out, static_cast<std::uint32_t>(data.size()));
        const auto start = out.size();
        out.insert(out.end(), type, type + 4);
        out.insert(out.end(), data.begin(), data.end());
        put32(out, static_cast<std::uint32_t>(crc32(0L, &out[start], static_cast<uInt>(data.size() + 4))));
    };
    std::vector<std::uint8_t> header;
    put32(header, image.width);
    put32(header, image.height);
    header.insert(header.end(), {8, 2, 0, 0, 0});
    chunk("IHDR", header);
    chunk("IDAT", compressed);
    chunk("IEND", {});
    return out;
}

} // namespace dstns::env
