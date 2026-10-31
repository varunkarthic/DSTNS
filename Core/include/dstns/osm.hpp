// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once
#include "dstns/model.hpp"
#include <filesystem>
namespace dstns {
struct OsmRoadGraph { NodeId root; std::vector<NodeStatic> nodes; std::vector<EdgeStatic> edges; std::string source_hash; std::vector<MapFeature> features; double projection_lat{}, projection_lon{}; };
// Where to grow the district from. When a seed has resolved to real
// coordinates the district starts at the road node nearest that point, so
// re-rolling within one downloaded city extract lands somewhere genuinely
// different. Without an anchor the loader falls back to seeded sector
// selection, which is what bare fixtures use.
struct DistrictAnchor {
    bool valid{false};
    double lat{}, lon{};
    // Upper bound on district size. Kept well below the extract so several
    // distinct districts fit inside one city, and so the browser has a
    // tractable amount of geometry to draw.
    std::uint32_t target_nodes{3000};
};

class OsmRoadLoader {
public:
    [[nodiscard]] OsmRoadGraph load_xml(const std::filesystem::path& file,std::uint32_t max_nodes,const DeterministicRng& rng,
                                        const DistrictAnchor& anchor = {}) const;
};
} // namespace dstns
