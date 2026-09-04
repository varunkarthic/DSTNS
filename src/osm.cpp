#include "dstns/osm.hpp"
#include "dstns/graph.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <map>
#include <queue>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string_view>

namespace dstns {
namespace {

struct RawNode {
    std::int64_t id{};
    double lat{}, lon{};
    bool bus_stop{false};
    bool signal{false};
    std::optional<BuildingType> building;
};

struct RawWay {
    std::int64_t id{};
    std::vector<std::int64_t> refs;
    std::string highway;
    bool oneway{false};
};

std::string extract_attr(std::string_view s, std::string_view key) {
    const auto pos = s.find(key);
    if (pos == std::string_view::npos) return {};
    const auto eq = s.find('=', pos + key.size());
    if (eq == std::string_view::npos) return {};
    const auto q1 = s.find_first_of("\"'", eq + 1);
    if (q1 == std::string_view::npos) return {};
    const auto q2 = s.find(s[q1], q1 + 1);
    if (q2 == std::string_view::npos) return {};
    return std::string(s.substr(q1 + 1, q2 - q1 - 1));
}

bool allowed(const std::string& h) {
    static const std::set<std::string> a{
        "motorway", "motorway_link", "trunk", "trunk_link",
        "primary", "primary_link", "secondary", "secondary_link",
        "tertiary", "tertiary_link", "unclassified", "residential",
        "living_street", "service", "track"
    };
    return a.contains(h);
}

RoadClass cls(const std::string& h) {
    if (h.find("motorway") != std::string::npos || h.find("trunk") != std::string::npos) return RoadClass::Motorway;
    if (h.find("primary") != std::string::npos) return RoadClass::Primary;
    if (h.find("secondary") != std::string::npos) return RoadClass::Secondary;
    if (h.find("tertiary") != std::string::npos) return RoadClass::Tertiary;
    if (h == "service" || h == "track" || h == "living_street") return RoadClass::Service;
    return RoadClass::Residential;
}

double speed_for(RoadClass c) {
    switch (c) {
        case RoadClass::Motorway: return 30.00; // 108 km/h
        case RoadClass::Primary: return 16.67;  // 60 km/h
        case RoadClass::Secondary: return 13.89;// 50 km/h
        case RoadClass::Tertiary: return 11.11; // 40 km/h
        case RoadClass::Residential: return 8.33; // 30 km/h
        case RoadClass::Service: return 5.56;   // 20 km/h
    }
    return 8.33;
}

double cap_for(RoadClass c) {
    switch (c) {
        case RoadClass::Motorway: return 4800;
        case RoadClass::Primary: return 3200;
        case RoadClass::Secondary: return 2400;
        case RoadClass::Tertiary: return 1800;
        case RoadClass::Residential: return 1100;
        case RoadClass::Service: return 600;
    }
    return 1100;
}

} // namespace

OsmRoadGraph OsmRoadLoader::load_xml(const std::filesystem::path& file, std::uint32_t max_nodes, const DeterministicRng& rng) const {
    std::ifstream in(file);
    if (!in) throw std::invalid_argument("cannot open OSM XML: " + file.string());
    std::ostringstream buffer;
    buffer << in.rdbuf();
    const auto xml = buffer.str();
    const std::string_view sv(xml);

    std::map<std::int64_t, RawNode> raw_nodes;
    std::vector<RawWay> ways;

    // Fast tokenizer for <node> and <way>
    std::size_t idx = 0;
    while (idx < sv.size()) {
        const auto npos = sv.find("<node ", idx);
        const auto wpos = sv.find("<way ", idx);
        if (npos == std::string_view::npos && wpos == std::string_view::npos) break;

        if (npos != std::string_view::npos && (wpos == std::string_view::npos || npos < wpos)) {
            // Parse <node ...>
            const auto endTag = sv.find('>', npos);
            if (endTag == std::string_view::npos) break;
            const auto tag = sv.substr(npos, endTag - npos + 1);

            const auto idStr = extract_attr(tag, "id");
            const auto latStr = extract_attr(tag, "lat");
            const auto lonStr = extract_attr(tag, "lon");

            if (!idStr.empty() && !latStr.empty() && !lonStr.empty()) {
                const auto nid = std::stoll(idStr);
                RawNode rn{nid, std::stod(latStr), std::stod(lonStr)};

                // Check if has inner tags before </node>
                if (tag.find("/>") == std::string_view::npos) {
                    const auto closeNode = sv.find("</node>", endTag);
                    if (closeNode != std::string_view::npos && closeNode - endTag < 2000) {
                        const auto body = sv.substr(endTag + 1, closeNode - endTag - 1);
                        std::size_t tIdx = 0;
                        while ((tIdx = body.find("<tag ", tIdx)) != std::string_view::npos) {
                            const auto tEnd = body.find('>', tIdx);
                            if (tEnd == std::string_view::npos) break;
                            const auto tTag = body.substr(tIdx, tEnd - tIdx + 1);
                            const auto k = extract_attr(tTag, "k");
                            const auto v = extract_attr(tTag, "v");
                            if (k == "highway" && (v == "bus_stop" || v == "platform")) rn.bus_stop = true;
                            if (k == "amenity" && v == "bus_station") rn.bus_stop = true;
                            if (k == "highway" && v == "traffic_signals") rn.signal = true;
                            if (k == "amenity" && (v == "school" || v == "university" || v == "college" || v == "kindergarten")) rn.building = BuildingType::School;
                            if (k == "office" || (k == "amenity" && (v == "bank" || v == "courthouse" || v == "townhall"))) rn.building = BuildingType::Office;
                            if ((k == "shop" && v == "mall") || (k == "amenity" && v == "marketplace")) rn.building = BuildingType::Mall;
                            if (k == "shop" || (k == "amenity" && (v == "restaurant" || v == "cafe" || v == "fast_food" || v == "pharmacy"))) rn.building = BuildingType::Store;
                            tIdx = tEnd + 1;
                        }
                        idx = closeNode + 7;
                    } else {
                        idx = endTag + 1;
                    }
                } else {
                    idx = endTag + 1;
                }
                raw_nodes.emplace(nid, std::move(rn));
            } else {
                idx = endTag + 1;
            }
        } else {
            // Parse <way ...> ... </way>
            const auto closeWay = sv.find("</way>", wpos);
            if (closeWay == std::string_view::npos) break;
            const auto wayBlock = sv.substr(wpos, closeWay - wpos + 6);
            const auto endWayTag = wayBlock.find('>');

            const auto wayHeader = wayBlock.substr(0, endWayTag + 1);
            const auto idStr = extract_attr(wayHeader, "id");
            if (!idStr.empty()) {
                RawWay rw;
                rw.id = std::stoll(idStr);

                std::size_t ndPos = 0;
                while ((ndPos = wayBlock.find("<nd ", ndPos)) != std::string_view::npos) {
                    const auto ndEnd = wayBlock.find('>', ndPos);
                    if (ndEnd == std::string_view::npos) break;
                    const auto ndTag = wayBlock.substr(ndPos, ndEnd - ndPos + 1);
                    const auto ref = extract_attr(ndTag, "ref");
                    if (!ref.empty()) rw.refs.push_back(std::stoll(ref));
                    ndPos = ndEnd + 1;
                }

                std::size_t tagPos = 0;
                while ((tagPos = wayBlock.find("<tag ", tagPos)) != std::string_view::npos) {
                    const auto tagEnd = wayBlock.find('>', tagPos);
                    if (tagEnd == std::string_view::npos) break;
                    const auto tagStr = wayBlock.substr(tagPos, tagEnd - tagPos + 1);
                    const auto k = extract_attr(tagStr, "k");
                    const auto v = extract_attr(tagStr, "v");
                    if (k == "highway") rw.highway = v;
                    if (k == "oneway") rw.oneway = (v == "yes" || v == "1" || v == "true");
                    if (k == "access" && (v == "private" || v == "no")) rw.highway.clear();
                    tagPos = tagEnd + 1;
                }

                if (allowed(rw.highway) && rw.refs.size() > 1) {
                    ways.push_back(std::move(rw));
                }
            }
            idx = closeWay + 6;
        }
    }

    if (ways.empty()) throw std::invalid_argument("OSM contains no eligible road ways");

    // Build node adjacency
    std::set<std::int64_t> referenced;
    std::map<std::int64_t, std::set<std::int64_t>> adjacency;
    for (const auto& w : ways) {
        for (std::size_t i = 1; i < w.refs.size(); ++i) {
            if (raw_nodes.contains(w.refs[i - 1]) && raw_nodes.contains(w.refs[i])) {
                referenced.insert(w.refs[i - 1]);
                referenced.insert(w.refs[i]);
                adjacency[w.refs[i - 1]].insert(w.refs[i]);
                adjacency[w.refs[i]].insert(w.refs[i - 1]);
            }
        }
    }

    if (referenced.empty()) throw std::invalid_argument("eligible OSM ways reference no available nodes");

    // Deterministic connected BFS from random anchor
    std::vector<std::int64_t> anchors(referenced.begin(), referenced.end());
    const auto root_osm = anchors[rng.bounded({RngDomain::MapSelection, 0, 0, 0}, static_cast<std::uint32_t>(anchors.size()))];
    std::vector<std::int64_t> selected;
    std::set<std::int64_t> seen{root_osm};
    std::queue<std::int64_t> q;
    q.push(root_osm);

    const auto target_nodes = std::min(max_nodes, static_cast<std::uint32_t>(referenced.size()));
    while (!q.empty() && selected.size() < target_nodes) {
        const auto u = q.front();
        q.pop();
        selected.push_back(u);
        for (auto v : adjacency[u]) {
            if (!seen.contains(v)) {
                seen.insert(v);
                q.push(v);
            }
        }
    }

    std::sort(selected.begin(), selected.end());
    std::map<std::int64_t, NodeId> ids;
    double lat0 = 0, lon0 = 0;
    for (auto id : selected) {
        lat0 += raw_nodes.at(id).lat;
        lon0 += raw_nodes.at(id).lon;
    }
    lat0 /= selected.size();
    lon0 /= selected.size();

    OsmRoadGraph out;
    for (std::size_t i = 0; i < selected.size(); ++i) {
        ids[selected[i]] = NodeId{static_cast<std::uint32_t>(i)};
        const auto& r = raw_nodes.at(selected[i]);
        NodeStatic n;
        n.id = {static_cast<std::uint32_t>(i)};
        n.osm_node_id = r.id;
        n.position.lat = r.lat;
        n.position.lon = r.lon;
        n.position.y_m = (r.lat - lat0) * 111320.0;
        n.position.x_m = (r.lon - lon0) * 111320.0 * std::cos(lat0 * 3.141592653589793 / 180.0);
        n.bus_stop = r.bus_stop;
        n.signal = r.signal;
        n.building = r.building;
        if (n.building) {
            n.building_impact = 0.50;
            n.building_radius_m = 250.0;
            switch (*n.building) {
                case BuildingType::School: n.tmax = {{291667, 375000, 3, 3}, {625000, 687500, 3, 3}}; break;
                case BuildingType::Office: n.tmax = {{312500, 416667, 2, 3}, {687500, 812500, 3, 2}}; break;
                case BuildingType::Mall: n.tmax = {{437500, 937500, 1, 1}}; break;
                case BuildingType::Store: n.tmax = {{354167, 895833, 1, 1}}; break;
            }
        }
        n.flood_susceptibility = .2 + .75 * rng.uniform01({RngDomain::DwsField, n.id.value, 1, 0});
        n.drainage = .2 + .7 * rng.uniform01({RngDomain::DwsField, n.id.value, 2, 0});
        out.nodes.push_back(n);
    }
    out.root = ids.at(root_osm);

    std::uint32_t segment = 0;
    for (const auto& w : ways) {
        for (std::size_t i = 1; i < w.refs.size(); ++i) {
            if (!ids.contains(w.refs[i - 1]) || !ids.contains(w.refs[i])) continue;
            const auto a = ids.at(w.refs[i - 1]), b = ids.at(w.refs[i]);
            const auto rc = cls(w.highway);
            const auto first = static_cast<std::uint32_t>(out.edges.size());
            for (std::uint32_t d = 0; d < 2; ++d) {
                EdgeStatic e;
                e.id = {static_cast<std::uint32_t>(out.edges.size())};
                e.from = d ? b : a;
                e.to = d ? a : b;
                e.reverse_twin = {first + (1 - d)};
                e.osm_way_id = w.id;
                e.segment_index = segment;
                e.road_class = rc;
                e.source_oneway = w.oneway;
                e.synthetic_reverse = w.oneway && d == 1;
                e.lanes = rc == RoadClass::Motorway ? 3 : (rc == RoadClass::Primary ? 2 : 1);
                e.length_m = point_distance(out.nodes[e.from.value].position, out.nodes[e.to.value].position);
                e.free_speed_mps = speed_for(rc);
                e.base_capacity_vph = cap_for(rc);
                e.flood_susceptibility = (out.nodes[a.value].flood_susceptibility + out.nodes[b.value].flood_susceptibility) / 2;
                e.geometry = {out.nodes[e.from.value].position, out.nodes[e.to.value].position};
                out.edges.push_back(std::move(e));
            }
            out.nodes[a.value].degree++;
            out.nodes[b.value].degree++;
            ++segment;
        }
    }

    out.source_hash = "sha256:" + sha256(xml.substr(0, std::min<std::size_t>(xml.size(), 10000)));
    return out;
}

} // namespace dstns
