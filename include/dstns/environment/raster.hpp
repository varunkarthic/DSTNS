// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// Mapped shapes onto the environment grid: which cells a polygon covers (by
// cell centre, even-odd rule) and which cells a polyline crosses.

#include "dstns/environment/grid.hpp"
#include "dstns/model.hpp"

#include <functional>
#include <vector>

namespace dstns::env {

/// Call `mark` with the index of every cell whose centre lies inside `ring`.
/// The ring may be open or closed. Only the cells inside its bounding box are
/// tested, so a district's worth of footprints costs their total area.
void rasterize_polygon(const GridSpec& grid, const std::vector<Point>& ring, const std::function<void(std::size_t)>& mark);

/// The cells a polyline passes through, sampled every half cell, in order and
/// without consecutive repeats.
[[nodiscard]] std::vector<std::uint32_t> cells_along(const GridSpec& grid, const std::vector<Point>& line);

/// Whether a mapped feature's tags make it pervious ground (park, grass,
/// woodland, pitch...) or open water that takes runoff (basin, reservoir).
[[nodiscard]] bool is_pervious(const MapFeature& feature);
[[nodiscard]] bool is_open_water(const MapFeature& feature);

} // namespace dstns::env
