#pragma once
#include "dstns/model.hpp"
#include <filesystem>
namespace dstns {
struct OsmRoadGraph { NodeId root; std::vector<NodeStatic> nodes; std::vector<EdgeStatic> edges; std::string source_hash; };
class OsmRoadLoader {
public:
    [[nodiscard]] OsmRoadGraph load_xml(const std::filesystem::path& file,std::uint32_t max_nodes,const DeterministicRng& rng) const;
};
} // namespace dstns
