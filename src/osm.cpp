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
    std::map<std::string, std::string> tags;
};

struct RawWay {
    std::int64_t id{};
    std::vector<std::int64_t> refs;
    std::string highway;
    bool oneway{false};
    std::map<std::string, std::string> tags;
};

std::string extract_attr(std::string_view s, std::string_view key) {
    // Match complete attribute names and XML whitespace, including pretty-printed inputs.
    std::size_t pos = 0, q1 = std::string_view::npos;
    while ((pos = s.find(key, pos)) != std::string_view::npos) {
        if (pos == 0 || std::string_view(" \t\r\n").find(s[pos - 1]) == std::string_view::npos) { pos += key.size(); continue; }
        auto eq = s.find_first_not_of(" \t\r\n", pos + key.size());
        if (eq == std::string_view::npos || s[eq] != '=') { pos += key.size(); continue; }
        q1 = s.find_first_not_of(" \t\r\n", eq + 1);
        if (q1 != std::string_view::npos && (s[q1] == '\"' || s[q1] == '\'')) break;
        return {};
    }
    if (q1 == std::string_view::npos) return {};
    const auto q2 = s.find(s[q1], q1 + 1);
    if (q2 == std::string_view::npos) return {};
    auto result=std::string(s.substr(q1+1,q2-q1-1));
    for(const auto& [encoded,decoded]:std::vector<std::pair<std::string,std::string>>{{"&quot;","\""},{"&apos;","'"},{"&lt;","<"},{"&gt;",">"},{"&amp;","&"}}){std::size_t at=0;while((at=result.find(encoded,at))!=std::string::npos){result.replace(at,encoded.size(),decoded);at+=decoded.size();}}
    return result;
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
    std::vector<RawWay> ways, feature_ways;

    // Fast tokenizer for <node> and <way>
    std::size_t idx = 0;
    while (idx < sv.size()) {
        const auto next = sv.find('<',idx);
        if(next==std::string_view::npos)break;
        const auto npos=sv.substr(next,6)=="<node "?next:std::string_view::npos;
        const auto wpos=sv.substr(next,5)=="<way "?next:std::string_view::npos;
        if(npos==std::string_view::npos&&wpos==std::string_view::npos){idx=next+1;continue;}

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
                RawNode rn; rn.id=nid; rn.lat=std::stod(latStr); rn.lon=std::stod(lonStr);
                if (!std::isfinite(rn.lat)||!std::isfinite(rn.lon)||std::abs(rn.lat)>90||std::abs(rn.lon)>180) throw std::invalid_argument("invalid OSM coordinates");

                // Check if has inner tags before </node>
                if (tag.find("/>") == std::string_view::npos) {
                    const auto closeNode = sv.find("</node>", endTag);
                    if (closeNode != std::string_view::npos && closeNode > endTag) {
                        const auto body = sv.substr(endTag + 1, closeNode - endTag - 1);
                        std::size_t tIdx = 0;
                        while ((tIdx = body.find("<tag ", tIdx)) != std::string_view::npos) {
                            const auto tEnd = body.find('>', tIdx);
                            if (tEnd == std::string_view::npos) break;
                            const auto tTag = body.substr(tIdx, tEnd - tIdx + 1);
                            const auto k = extract_attr(tTag, "k");
                            const auto v = extract_attr(tTag, "v");
                            rn.tags[k] = v;
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
                    rw.tags[k] = v;
                    if (k == "highway") rw.highway = v;
                    if (k == "oneway") rw.oneway = (v == "yes" || v == "1" || v == "true");
                    if (k == "access" && (v == "private" || v == "no")) rw.highway.clear();
                    tagPos = tagEnd + 1;
                }

                if (rw.tags.contains("building") || rw.tags.contains("amenity") || rw.tags.contains("shop") || rw.tags.contains("office") || rw.tags.contains("leisure") || rw.tags.contains("landuse") || rw.tags.contains("railway") || rw.tags.contains("public_transport")) feature_ways.push_back(rw);
                if (rw.tags["oneway"] == "-1") { rw.oneway=true; std::reverse(rw.refs.begin(),rw.refs.end()); }
                if (rw.tags["junction"] == "roundabout" && !rw.tags.contains("oneway")) rw.oneway=true;
                if (allowed(rw.highway) && rw.tags["access"] != "private" && rw.tags["access"] != "no" && rw.refs.size() > 1) {
                    ways.push_back(std::move(rw));
                }
            }
            idx = closeWay + 6;
        }
    }

    std::sort(ways.begin(),ways.end(),[](const auto& a,const auto& b){return a.id<b.id;});
    if (max_nodes < 2 || max_nodes > 50000) throw std::invalid_argument("max_nodes must be in [2,50000]");
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

    // Compute geographic bounding box across all referenced nodes
    double min_lat = 90.0, max_lat = -90.0, min_lon = 180.0, max_lon = -180.0;
    for (const auto id : referenced) {
        const auto& n = raw_nodes.at(id);
        if (n.lat < min_lat) min_lat = n.lat;
        if (n.lat > max_lat) max_lat = n.lat;
        if (n.lon < min_lon) min_lon = n.lon;
        if (n.lon > max_lon) max_lon = n.lon;
    }
    const double mid_lat = (min_lat + max_lat) / 2.0;
    const double mid_lon = (min_lon + max_lon) / 2.0;

    // Connected Radial Frontier Growth (CRFG, Section 5.3)
    // Partition anchors into 9 geographic sectors to guarantee vastly different maps across seeds
    std::vector<std::int64_t> anchors;
    for (const auto id : referenced) {
        if (adjacency[id].size() >= 2) anchors.push_back(id);
    }
    if (anchors.empty()) anchors.assign(referenced.begin(), referenced.end());

    // Deterministically pick a target sector (0: North, 1: North-East, 2: East, 3: South-East, 4: South, 5: South-West, 6: West, 7: North-West, 8: Central Core)
    const std::uint32_t sector_idx = rng.bounded({RngDomain::MapSelection, 0, 0, 1}, 9);
    std::vector<std::int64_t> sector_anchors;
    for (const auto id : anchors) {
        const auto& n = raw_nodes.at(id);
        const bool north = n.lat >= mid_lat;
        const bool east = n.lon >= mid_lon;
        switch (sector_idx) {
            case 0: if (north && std::abs(n.lon - mid_lon) < (max_lon - min_lon) * 0.25) sector_anchors.push_back(id); break;
            case 1: if (north && east) sector_anchors.push_back(id); break;
            case 2: if (east && std::abs(n.lat - mid_lat) < (max_lat - min_lat) * 0.25) sector_anchors.push_back(id); break;
            case 3: if (!north && east) sector_anchors.push_back(id); break;
            case 4: if (!north && std::abs(n.lon - mid_lon) < (max_lon - min_lon) * 0.25) sector_anchors.push_back(id); break;
            case 5: if (!north && !east) sector_anchors.push_back(id); break;
            case 6: if (!east && std::abs(n.lat - mid_lat) < (max_lat - min_lat) * 0.25) sector_anchors.push_back(id); break;
            case 7: if (north && !east) sector_anchors.push_back(id); break;
            default: if (std::abs(n.lat - mid_lat) < (max_lat - min_lat) * 0.25 && std::abs(n.lon - mid_lon) < (max_lon - min_lon) * 0.25) sector_anchors.push_back(id); break;
        }
    }
    const auto& candidate_pool = !sector_anchors.empty() ? sector_anchors : anchors;

    // Version urban-crfg-v2: real connected districts, with thousands of nodes when available.
    const auto available=static_cast<std::uint32_t>(referenced.size());
    const auto district_limit=available>250?static_cast<std::uint32_t>(available*(.55+.20*rng.uniform01({RngDomain::MapSelection,0,2,2}))):available;
    const auto target_nodes = std::min({max_nodes,district_limit,4000u+rng.bounded({RngDomain::MapSelection,0,1,2},2001)});

    std::vector<std::int64_t> selected;
    std::int64_t root_osm = 0, best_root = 0;
    std::vector<std::int64_t> best_selected;

    struct CrfgCandidate {
        double dist;
        std::int64_t osm_id;
        bool operator>(const CrfgCandidate& o) const {
            if (dist != o.dist) return dist > o.dist;
            return osm_id > o.osm_id;
        }
    };

    // Retry counter 'a' if component is too small
    for (std::uint32_t a = 0; a < 16; ++a) {
        selected.clear();
        root_osm = candidate_pool[rng.bounded({RngDomain::MapSelection, a, 0, 0}, static_cast<std::uint32_t>(candidate_pool.size()))];
        const auto& r_root = raw_nodes.at(root_osm);
        const double root_lat = r_root.lat;

        std::set<std::int64_t> finalized;
        std::map<std::int64_t, double> distance{{root_osm, 0.0}};
        std::priority_queue<CrfgCandidate, std::vector<CrfgCandidate>, std::greater<CrfgCandidate>> pq;
        pq.push({0.0, root_osm});

        while (!pq.empty() && selected.size() < target_nodes) {
            const auto top = pq.top();
            pq.pop();
            if (finalized.contains(top.osm_id)) continue;
            finalized.insert(top.osm_id);
            selected.push_back(top.osm_id);

            for (auto v : adjacency[top.osm_id]) {
                if (finalized.contains(v)) continue;
                const auto& r_u = raw_nodes.at(top.osm_id);
                const auto& r_v = raw_nodes.at(v);
                const double dy = (r_v.lat - r_u.lat) * 111320.0;
                const double dx = (r_v.lon - r_u.lon) * 111320.0 * std::cos(root_lat * 3.141592653589793 / 180.0);
                const double candidate = top.dist + std::sqrt(dx * dx + dy * dy);
                const auto known = distance.find(v);
                if (known == distance.end() || candidate < known->second) {
                    distance[v] = candidate;
                    pq.push({candidate, v});
                }
            }
        }

        if (selected.size() > best_selected.size()) { best_selected=selected; best_root=root_osm; }
        if (selected.size() >= target_nodes) {
            break;
        }
    }

    selected=std::move(best_selected); root_osm=best_root;
    if (selected.size()<2) throw std::invalid_argument("OSM has no usable connected region");
    std::sort(selected.begin(), selected.end());
    std::map<std::int64_t, NodeId> ids;
    double lat0 = 0, lon0 = 0;
    for (auto id : selected) {
        lat0 += raw_nodes.at(id).lat;
        lon0 += raw_nodes.at(id).lon;
    }
    lat0 /= selected.size();
    lon0 /= selected.size();

    OsmRoadGraph out; out.projection_lat=lat0; out.projection_lon=lon0;
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
            if (!ids.contains(w.refs[i - 1]) || !ids.contains(w.refs[i]) || w.refs[i-1]==w.refs[i]) continue;
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
                e.name = w.tags.contains("name") ? w.tags.at("name") : "";
                e.tags = w.tags;
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

    auto project = [&](double lat,double lon) { return Point{(lon-lon0)*111320.0*std::cos(lat0*3.141592653589793/180), (lat-lat0)*111320.0, lat,lon}; };
    double loX=1e20,loY=1e20,hiX=-1e20,hiY=-1e20;
    for(const auto& n:out.nodes){loX=std::min(loX,n.position.x_m);loY=std::min(loY,n.position.y_m);hiX=std::max(hiX,n.position.x_m);hiY=std::max(hiY,n.position.y_m);}
    auto add_feature = [&](std::string id,const auto& tags,std::vector<Point> geometry,bool polygon) {
        if(geometry.empty()) return;
        MapFeature f; f.id=std::move(id); f.tags=tags; f.geometry=std::move(geometry); f.polygon=polygon;
        for(const auto& p:f.geometry){f.center.x_m+=p.x_m;f.center.y_m+=p.y_m;f.center.lat+=p.lat;f.center.lon+=p.lon;}
        const auto size=double(f.geometry.size()); f.center.x_m/=size;f.center.y_m/=size;f.center.lat/=size;f.center.lon/=size;
        if(f.center.x_m<loX||f.center.x_m>hiX||f.center.y_m<loY||f.center.y_m>hiY) return;
        auto tag=[&](const std::string& key){auto it=tags.find(key);return it==tags.end()?std::string{}:it->second;};
        f.name=tag("name"); f.category="building";
        for(const auto* key:{"building","landuse","leisure","railway","public_transport","office","shop","amenity"}) if(!tag(key).empty()) f.category=tag(key)=="yes"?key:tag(key);
        if(f.category=="school"||f.category=="college"||f.category=="university"||f.category=="kindergarten") f.demand_type=BuildingType::School;
        else if(!tag("office").empty()||f.category=="commercial"||f.category=="offices") f.demand_type=BuildingType::Office;
        else if(f.category=="mall"||f.category=="retail"||f.category=="marketplace") f.demand_type=BuildingType::Mall;
        else if(!tag("shop").empty()||f.category=="hospital"||f.category=="bus_station"||f.category=="station"||f.category=="restaurant"||f.category=="cafe"||f.category=="stadium") f.demand_type=BuildingType::Store;
        double nearest=1e20; for(const auto& n:out.nodes){const auto d=point_distance(n.position,f.center);if(d<nearest){nearest=d;f.anchor=n.id;}}
        out.features.push_back(std::move(f));
    };
    for(const auto& w:feature_ways){std::vector<Point> g;bool complete=true;for(auto id:w.refs){auto it=raw_nodes.find(id);if(it==raw_nodes.end()){complete=false;break;}g.push_back(project(it->second.lat,it->second.lon));}if(complete)add_feature("way/"+std::to_string(w.id),w.tags,std::move(g),w.refs.size()>3&&w.refs.front()==w.refs.back());}
    for(const auto& [id,n]:raw_nodes) if(n.tags.contains("amenity")||n.tags.contains("shop")||n.tags.contains("office")||n.tags.contains("leisure")||n.tags.contains("railway")||n.tags.contains("public_transport")||n.bus_stop) add_feature("node/"+std::to_string(id),n.tags,{project(n.lat,n.lon)},false);
    std::sort(out.features.begin(),out.features.end(),[](const auto& a,const auto& b){return a.id<b.id;});
    out.source_hash = "sha256:" + sha256(xml);
    return out;
}

} // namespace dstns
