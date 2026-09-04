#include "dstns/osm.hpp"
#include "dstns/scenario.hpp"

#include <iostream>
#include <string>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: dstns_road_index <osm_file.xml> [max_nodes]\n";
        return 1;
    }
    const std::string osm_file = argv[1];
    std::size_t max_nodes = (argc >= 3) ? std::stoul(argv[2]) : 50000;

    std::cout << "Loading OSM Road Network from: " << osm_file << " (max_nodes=" << max_nodes << ")\n";
    try {
        dstns::ScenarioConfig config;
        config.osm_file = osm_file;
        config.max_nodes = max_nodes;

        dstns::ScenarioCompiler compiler;
        auto seed = dstns::Seed128::parse("0x123456789ABCDEF0123456789ABCDEF0");
        auto scenario = compiler.compile(seed, config);

        std::cout << "Canonical Nodes: " << scenario.nodes.size() << "\n";
        std::cout << "Canonical Edges: " << scenario.edges.size() << "\n";
        std::cout << "Graph Hash:      " << scenario.graph_hash << "\n";
        std::cout << "Scenario Hash:   " << scenario.scenario_hash << "\n";
        std::cout << "Road Indexing complete.\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Error indexing OSM file: " << e.what() << "\n";
        return 1;
    }
}
