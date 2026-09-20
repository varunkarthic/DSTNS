#include "dstns/scenario.hpp"
#include "dstns/geo.hpp"
#include "dstns/osm_fetch.hpp"
#include "dstns/graph.hpp"
#include "dstns/osm.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <numeric>
#include <queue>
#include <sstream>
#include <stdexcept>

namespace dstns {
namespace {
constexpr std::uint32_t ppm_day=1'000'000, seconds_day=86'400;
RoadClass road_class(std::uint32_t x,std::uint32_t y){if(x%5==0)return RoadClass::Primary;if(y%4==0)return RoadClass::Secondary;if((x+y)%3==0)return RoadClass::Tertiary;return RoadClass::Residential;}
double speed(RoadClass c){switch(c){case RoadClass::Motorway:return 30.0;case RoadClass::Primary:return 16.67;case RoadClass::Secondary:return 13.89;case RoadClass::Tertiary:return 11.11;case RoadClass::Residential:return 8.33;case RoadClass::Service:return 5.56;}return 8.33;}
double capacity(RoadClass c){switch(c){case RoadClass::Motorway:return 4800;case RoadClass::Primary:return 3200;case RoadClass::Secondary:return 2400;case RoadClass::Tertiary:return 1800;case RoadClass::Residential:return 1100;case RoadClass::Service:return 600;}return 1100;}
std::string canonical_graph(const Scenario&s){std::ostringstream o;for(const auto&n:s.nodes)o<<n.id.value<<','<<n.osm_node_id<<','<<std::llround(n.position.x_m*1000)<<','<<std::llround(n.position.y_m*1000)<<';';for(const auto&e:s.edges)o<<e.id.value<<','<<e.from.value<<','<<e.to.value<<','<<e.reverse_twin.value<<','<<std::llround(e.length_m*1000)<<','<<e.synthetic_reverse<<';';return o.str();}

}

// Below this a district is not a street network worth simulating.
constexpr std::size_t kMinimumDistrictNodes = 400;

// A signal controller belongs where at least three ways meet. Below that the
// OSM tag denotes a crossing or a gate, not an intersection.
constexpr std::uint32_t kMinimumSignalDegree = 3;

// How far a tagged stop line may sit from the junction it governs. Approach
// stop lines are typically within a few car lengths of the intersection.
constexpr double kSignalSnapRadiusM = 45.0;

Scenario ScenarioCompiler::compile(Seed128 seed_value,const ScenarioConfig& config,const Progress& progress)const{
    const auto report=[&](Stage stage){ if(progress) progress(stage); };
    if(config.max_nodes<2||config.max_nodes>50000)throw std::invalid_argument("max_nodes must be in [2,50000]");
    if(config.map_selection_version!="urban-crfg-v3")throw std::invalid_argument("unsupported map selection version");
    if(config.day < -1 || config.day>1)throw std::invalid_argument("invalid day type");
    if(config.demand_bin_virtual_s==0||config.demand_bin_virtual_s>86400)throw std::invalid_argument("invalid demand bin");
    if(config.playback_duration_s<60||config.playback_duration_s>3600)throw std::invalid_argument("playback_duration_s must be in [60,3600]");
    auto effective_config = config;
    if(!(effective_config.tick_rate>0&&effective_config.tick_rate<=kMaxTickRate))throw std::invalid_argument("tick_rate must be in (0,5]");
    // "auto" means: let the seed choose a real place and fetch it on demand.
    // The tile is cached under its seed-derived name, so re-running one seed is
    // offline and free while a re-rolled seed necessarily downloads a new map.
    MapLocation location{};
    bool located = false, downloaded = false;
    if(effective_config.osm_file == "auto") {
        report(Stage::Selecting);
        location = select_map_location(seed_value, effective_config.map_city_extent_m);
        located = true;
        report(Stage::Acquiring);
        const auto tile = acquire_map_tile(location, effective_config.map_cache_dir);
        effective_config.osm_file = tile.file.string();
        downloaded = tile.downloaded;
    }
    if(effective_config.osm_file.empty()&&(effective_config.grid_width<3||effective_config.grid_height<3||std::uint64_t(effective_config.grid_width)*effective_config.grid_height>effective_config.max_nodes))throw std::invalid_argument("invalid grid dimensions or max_nodes");
    if(effective_config.dws_frequency>0&&std::uint64_t(effective_config.dws_frequency-1)*5>=effective_config.playback_duration_s)throw std::invalid_argument("DWS frequency violates five-playback-second spacing");
    report(Stage::Building);
    Scenario s; s.seed=seed_value;s.config=effective_config;

    // Cryptographically derived domain-separated sub-seeds
    const auto map_seed = seed_value.derive("map");
    const auto dws_seed = seed_value.derive("dws");
    const auto traffic_seed = seed_value.derive("traffic");
    const auto incident_seed = seed_value.derive("incidents");
    const auto scenario_seed = seed_value.derive("scenario");

    DeterministicRng map_rng(map_seed);
    DeterministicRng dws_rng(dws_seed);
    DeterministicRng traffic_rng(traffic_seed);
    DeterministicRng incident_rng(incident_seed);
    DeterministicRng scenario_rng(scenario_seed);

    if(s.config.day<0)s.config.day=0;
    if(s.config.day>1)throw std::invalid_argument("day must be 0, 1, or auto");
    if(effective_config.osm_file.empty()){
        build_canonical_grid(s,map_rng);
        s.map_hash="sha256:"+sha256("dstns/offline-road-fixture/v1");
    }else{
        DistrictAnchor district{};
        if(located){district.valid=true;district.lat=location.anchor_lat;district.lon=location.anchor_lon;district.target_nodes=effective_config.map_district_nodes;}
        auto road=OsmRoadLoader{}.load_xml(effective_config.osm_file,effective_config.max_nodes,map_rng,district);
        s.root=road.root;s.nodes=std::move(road.nodes);s.edges=std::move(road.edges);s.map_hash=std::move(road.source_hash);s.features=std::move(road.features);s.projection_lat=road.projection_lat;s.projection_lon=road.projection_lon;
        s.map_source_file=effective_config.osm_file;
        if(located){
            s.map_city=location.city;s.map_country=location.country;
            s.map_anchor_lat=location.anchor_lat;s.map_anchor_lon=location.anchor_lon;
            s.map_city_extent_m=location.extent_m;s.map_downloaded=downloaded;
            // A tile that lands on water, parkland or an unmapped area yields a
            // network too thin to simulate. Say so plainly instead of running a
            // degenerate scenario that looks like a working one.
            if(s.nodes.size()<kMinimumDistrictNodes){
                throw MapFetchError("The map tile for "+location.city+" ("+location.country+") at "
                    +std::to_string(location.anchor_lat)+", "+std::to_string(location.anchor_lon)
                    +" contains only "+std::to_string(s.nodes.size())+" road junctions (at least "
                    +std::to_string(kMinimumDistrictNodes)+" are needed). The area is mostly water or "
                    "unmapped; re-roll the seed for a different district.");
            }
        }
    }
    place_bus_stops(s);
    if(effective_config.buildings && effective_config.osm_file.empty())place_buildings(s,scenario_rng);
    if(effective_config.osm_file.empty())for(const auto& n:s.nodes)if(n.building){MapFeature f;f.id="fixture/"+std::to_string(n.id.value);f.category=to_string(*n.building);f.name="Synthetic "+f.category;f.center=n.position;f.geometry={n.position};f.demand_type=n.building;f.anchor=n.id;s.features.push_back(f);}
    if(effective_config.signals)plan_signals(s);
    if(effective_config.traffic){plan_hotspots(s,traffic_rng);plan_trips(s,traffic_rng);}
    if(effective_config.dws)plan_weather(s,dws_rng);
    if(effective_config.incidents)plan_incidents(s,incident_rng);
    calculate_hashes(s);
    return s;
}

void ScenarioCompiler::build_canonical_grid(Scenario&s,const DeterministicRng&rng)const{
    const auto w=s.config.grid_width,h=s.config.grid_height;const double spacing=180.0;
    // Map seed mixing selects metropolitan transport region from global catalog
    // The same world catalogue the downloaded maps are drawn from, so a
    // synthetic grid sits where its seed says it does.
    const auto& catalog = city_catalog();
    const auto city_idx = rng.bounded({RngDomain::MapSelection,0,0,0},static_cast<std::uint32_t>(catalog.size()));
    const auto& city = catalog[city_idx];
    const auto lat0 = city.lat + (rng.uniform01({RngDomain::MapSelection,0,1,0}) - 0.5) * 0.04;
    const auto lon0 = city.lon + (rng.uniform01({RngDomain::MapSelection,0,2,0}) - 0.5) * 0.04;
    s.nodes.reserve(std::size_t(w)*h);
    for(std::uint32_t y=0;y<h;++y)for(std::uint32_t x=0;x<w;++x){
        const auto id=y*w+x;
        NodeStatic n;
        n.id={id};
        n.osm_node_id=9'000'000'000LL+id;
        const double lat_deg = lat0 + y * spacing / 111320.0;
        const double lon_deg = lon0 + x * spacing / (111320.0 * std::cos(lat0 * 3.141592653589793 / 180.0));
        n.position={x*spacing,y*spacing,lat_deg,lon_deg};
        n.flood_susceptibility=.2+.75*rng.uniform01({RngDomain::DwsField,id,1,0});
        n.drainage=.2+.7*rng.uniform01({RngDomain::DwsField,id,2,0});
        s.nodes.push_back(n);
    }
    auto add=[&](NodeId a,NodeId b,RoadClass cls,std::uint32_t segment){
        const auto first=static_cast<std::uint32_t>(s.edges.size());
        const auto length=point_distance(s.nodes[a.value].position,s.nodes[b.value].position);
        for(int direction=0;direction<2;++direction){
            EdgeStatic e;
            e.id={static_cast<std::uint32_t>(s.edges.size())};
            e.from=direction?a:b;
            e.to=direction?b:a;
            e.reverse_twin={first+std::uint32_t(1-direction)};
            e.osm_way_id=8'000'000'000LL+segment;
            e.segment_index=0;
            e.road_class=cls;
            e.source_oneway=false;
            e.synthetic_reverse=false;
            e.lanes=cls==RoadClass::Primary?2:1;
            e.length_m=length;
            e.free_speed_mps=speed(cls);
            e.base_capacity_vph=capacity(cls);
            e.flood_susceptibility=(s.nodes[a.value].flood_susceptibility+s.nodes[b.value].flood_susceptibility)/2;
            e.geometry={s.nodes[e.from.value].position,s.nodes[e.to.value].position};
            s.edges.push_back(e);
        }
        s.nodes[a.value].degree++;
        s.nodes[b.value].degree++;
    };
    std::uint32_t seg=0;
    for(std::uint32_t y=0;y<h;++y)for(std::uint32_t x=0;x<w;++x){
        const NodeId here{y*w+x};
        if(x+1<w)add(here,{y*w+x+1},road_class(x,y),seg++);
        if(y+1<h)add(here,{(y+1)*w+x},road_class(x,y),seg++);
    }
    s.root={static_cast<std::uint32_t>((h/2)*w+w/2)};
}

void ScenarioCompiler::place_bus_stops(Scenario&s)const{
    const auto n=s.nodes.size();std::vector<std::vector<std::pair<NodeId,double>>> adj(n);for(std::size_t i=0;i<s.edges.size();i+=2){const auto&e=s.edges[i];adj[e.from.value].push_back({e.to,e.length_m});adj[e.to.value].push_back({e.from,e.length_m});}
    std::vector<int> shell(n,-1);std::queue<NodeId>q;shell[s.root.value]=0;q.push(s.root);while(!q.empty()){auto u=q.front();q.pop();std::sort(adj[u.value].begin(),adj[u.value].end(),[](auto a,auto b){return a.first.value<b.first.value;});for(auto[v,d]:adj[u.value]){(void)d;if(shell[v.value]<0){shell[v.value]=shell[u.value]+1;q.push(v);}}}
    std::vector<NodeId> order(n);for(std::size_t i=0;i<n;++i)order[i]=NodeId{static_cast<std::uint32_t>(i)};std::sort(order.begin(),order.end(),[&](auto a,auto b){if(shell[a.value]!=shell[b.value])return shell[a.value]<shell[b.value];if(s.nodes[a.value].degree!=s.nodes[b.value].degree)return s.nodes[a.value].degree>s.nodes[b.value].degree;return a.value<b.value;});
    auto graph_dist=[&](NodeId start,const std::vector<BusStop>&stops,double cutoff){std::vector<double>d(n,1e100);using P=std::pair<double,NodeId>;struct C{bool operator()(const P&a,const P&b)const{return a.first>b.first||(a.first==b.first&&a.second.value>b.second.value);}};std::priority_queue<P,std::vector<P>,C>pq;d[start.value]=0;pq.push({0,start});while(!pq.empty()){auto[du,u]=pq.top();pq.pop();if(du!=d[u.value]||du>cutoff)continue;for(const auto&st:stops)if(u==st.anchor_node)return du;for(auto[v,w]:adj[u.value])if(du+w<d[v.value]){d[v.value]=du+w;pq.push({d[v.value],v});}}return 1e100;};
    auto outgoing_edge=[&](NodeId node){return std::find_if(s.edges.begin(),s.edges.end(),[&](const auto&e){return e.from==node&&is_source_direction_allowed(e);});};
    for(auto candidate:order){if(s.nodes[candidate.value].degree<2)continue;const auto nearest=s.bus_stops.empty()?1e100:graph_dist(candidate,s.bus_stops,s.config.stop_min_spacing_m);if(s.bus_stops.empty()||nearest>=s.config.stop_min_spacing_m){auto it=outgoing_edge(candidate);if(it!=s.edges.end()){BusStop stop;stop.id={static_cast<std::uint32_t>(s.bus_stops.size())};stop.anchor_node=candidate;stop.edge=it->id;stop.position_m=std::min(15.0,it->length_m*.25);stop.nearest_stop_distance_m=s.bus_stops.empty()?0:nearest;s.bus_stops.push_back(stop);s.nodes[candidate.value].bus_stop=true;}}}
    // Coverage repair: deterministically add the farthest eligible node until all are within max coverage.
    for(;;){double farthest=-1;NodeId pick{};auto pick_edge=s.edges.end();for(const auto&node:s.nodes){if(node.degree<2||node.bus_stop)continue;const auto edge=outgoing_edge(node.id);if(edge==s.edges.end())continue;const auto d=graph_dist(node.id,s.bus_stops,1e9);if(d>farthest||(d==farthest&&node.id.value<pick.value)){farthest=d;pick=node.id;pick_edge=edge;}}if(farthest<=s.config.stop_max_coverage_m||farthest<0||pick_edge==s.edges.end())break;BusStop stop{{static_cast<std::uint32_t>(s.bus_stops.size())},pick,pick_edge->id,std::min(15.0,pick_edge->length_m*.25),farthest};s.bus_stops.push_back(stop);s.nodes[pick.value].bus_stop=true;}
}

void ScenarioCompiler::place_buildings(Scenario&s,const DeterministicRng&rng)const{
    const std::array<BuildingType,4> types{BuildingType::School,BuildingType::Office,BuildingType::Mall,BuildingType::Store};
    for(const auto&stop:s.bus_stops){if(rng.uniform01({RngDomain::Buildings,stop.id.value,0,0})>.72)continue;std::vector<NodeId> candidates;for(const auto&n:s.nodes){const auto d=point_distance(n.position,s.nodes[stop.anchor_node.value].position);if(d>=80&&d<=250&&!n.bus_stop&&!n.building)candidates.push_back(n.id);}if(candidates.empty())continue;std::sort(candidates.begin(),candidates.end(),[](auto a,auto b){return a.value<b.value;});auto chosen=candidates[rng.bounded({RngDomain::Buildings,stop.id.value,1,0},static_cast<std::uint32_t>(candidates.size()))];auto&n=s.nodes[chosen.value];n.building=types[rng.bounded({RngDomain::Buildings,stop.id.value,2,0},4)];const auto u=rng.uniform01({RngDomain::Buildings,stop.id.value,3,0});n.building_impact=.25+.6*u;n.building_radius_m=180+520*rng.uniform01({RngDomain::Buildings,stop.id.value,4,0});switch(*n.building){case BuildingType::School:n.tmax={{291667,375000,3,3},{625000,687500,3,3}};break;case BuildingType::Office:n.tmax={{312500,416667,2,3},{687500,812500,3,2}};break;case BuildingType::Mall:n.tmax={{437500,937500,1,1}};break;case BuildingType::Store:n.tmax={{354167,895833,1,1}};break;}}
}

void ScenarioCompiler::plan_signals(Scenario& s) const {
    DeterministicRng rng(s.seed.derive("signals"));
    // Approach capacity per axis: [0] = north-south, [1] = east-west. Green time
    // is split between the two opposing groups in proportion to what arrives.
    std::vector<std::array<double,2>> demand(s.nodes.size(), {1.0,1.0});
    for(const auto& e:s.edges) if(is_source_direction_allowed(e)) {
        const auto& a=s.nodes[e.from.value].position;const auto& b=s.nodes[e.to.value].position;
        demand[e.to.value][std::abs(b.y_m-a.y_m)>=std::abs(b.x_m-a.x_m)?0:1]+=e.base_capacity_vph;
    }

    // Place controllers at intersections, not mid-block.
    //
    // OpenStreetMap almost never tags `highway=traffic_signals` on the shared
    // junction node: it tags the stop-line node a few metres back along one
    // approach, which in this graph has degree 2. Taking the tags literally
    // scatters signals along straight roads; discarding everything below degree
    // three deletes all of them. So each tagged node is snapped to the nearest
    // real junction within kSignalSnapRadiusM, and several approaches to one
    // junction collapse to the single controller that governs it.
    std::vector<NodeId> junctions;
    for(const auto& n:s.nodes) if(n.degree>=kMinimumSignalDegree) junctions.push_back(n.id);

    // Bucket junctions so snapping stays linear in the number of tagged nodes.
    std::map<std::pair<int,int>,std::vector<NodeId>> junction_cells;
    const double cell=kSignalSnapRadiusM;
    for(const auto id:junctions){
        const auto& p=s.nodes[id.value].position;
        junction_cells[{int(std::floor(p.x_m/cell)),int(std::floor(p.y_m/cell))}].push_back(id);
    }

    std::vector<bool> controls(s.nodes.size(),false);
    const auto snap=[&](const NodeStatic& tagged){
        const auto& p=tagged.position;
        const int cx=int(std::floor(p.x_m/cell)), cy=int(std::floor(p.y_m/cell));
        double best=kSignalSnapRadiusM*kSignalSnapRadiusM; NodeId chosen{}; bool found=false;
        for(int dx=-1;dx<=1;++dx)for(int dy=-1;dy<=1;++dy){
            const auto it=junction_cells.find({cx+dx,cy+dy});
            if(it==junction_cells.end())continue;
            for(const auto id:it->second){
                const auto& q=s.nodes[id.value].position;
                const double d=(q.x_m-p.x_m)*(q.x_m-p.x_m)+(q.y_m-p.y_m)*(q.y_m-p.y_m);
                // Ties resolve by id so the choice never depends on iteration order.
                if(d<best||(d==best&&found&&id.value<chosen.value)){best=d;chosen=id;found=true;}
            }
        }
        return std::pair{found,chosen};
    };

    for(const auto& n:s.nodes){
        const bool synthetic = s.config.osm_file.empty() && n.degree>=4 && n.id.value%3==0;
        if(synthetic){ controls[n.id.value]=true; continue; }
        if(!n.signal) continue;
        if(n.degree>=kMinimumSignalDegree){ controls[n.id.value]=true; continue; }
        const auto [found,at]=snap(n);
        // A tagged node with no junction nearby is a pedestrian crossing or a
        // gated driveway. Those are real, but they are not intersections.
        if(found) controls[at.value]=true;
    }
    for(auto& n:s.nodes) n.signal=controls[n.id.value];

    // Offsets form a progression along the dominant travel axis rather than being
    // drawn at random. Signals a block apart then turn green in sequence - the
    // "green wave" a real corridor is timed for - instead of flickering
    // independently. The reference speed is a nominal 50 km/h arterial.
    constexpr double kProgressionSpeedMps = 13.9;
    double origin_x = 0, origin_y = 0;
    std::size_t controllers = 0;
    for(const auto& n:s.nodes) if(n.signal) { origin_x+=n.position.x_m; origin_y+=n.position.y_m; ++controllers; }
    if(controllers) { origin_x/=double(controllers); origin_y/=double(controllers); }

    for(auto& n:s.nodes) if(n.signal) {
        const auto id=static_cast<std::uint64_t>(n.osm_node_id);
        const double total=demand[n.id.value][0]+demand[n.id.value][1];
        const auto cycle=std::uint16_t(std::clamp(45.0+4.0*n.degree+total/1200.0+20.0*rng.uniform01({RngDomain::TrafficSignals,id,0,0}),50.0,120.0));
        const auto green=std::uint16_t(std::clamp(double(cycle-8)*demand[n.id.value][0]/total,12.0,double(cycle-20)));
        const auto other=std::uint16_t(cycle-8-green);
        n.signal_cycle_s=cycle;n.signal_green_s=green;
        // Travel time from the network's centre to this junction, wrapped into
        // the cycle. Neighbouring junctions differ by the time it takes to drive
        // between them, so a platoon released at one arrives at the next on green.
        const double distance=std::hypot(n.position.x_m-origin_x,n.position.y_m-origin_y);
        const double travel=distance/kProgressionSpeedMps;
        n.signal_offset_s=std::uint16_t(std::llround(std::fmod(travel,double(cycle))));
        s.signals.push_back({n.id,cycle,{green,3,1,other,3,1},n.signal_offset_s});
    }
}
void ScenarioCompiler::plan_hotspots(Scenario&s,const DeterministicRng&rng)const{std::vector<std::pair<double,EdgeId>>scores;for(auto&e:s.edges){if(!is_source_direction_allowed(e))continue;const auto central=(s.nodes[e.from.value].degree+s.nodes[e.to.value].degree)/8.0;const auto score=central*(.5+.5*rng.uniform01({RngDomain::TrafficControl,e.id.value,1,0}));scores.push_back({score,e.id});}const auto count=std::min<std::size_t>(std::clamp<std::size_t>(s.edges.size()/80,1,24),scores.size());std::sort(scores.begin(),scores.end(),[](auto a,auto b){return a.first!=b.first?a.first>b.first:a.second.value<b.second.value;});for(std::size_t i=0;i<count;++i){s.hotspot_edges.push_back(scores[i].second);s.edges[scores[i].second.value].hotspot_susceptibility=.5+.5*rng.uniform01({RngDomain::TrafficControl,scores[i].second.value,2,0});}}
void ScenarioCompiler::plan_trips(Scenario&s,const DeterministicRng&rng)const{GraphStore g(s);RoutePlanner router(g);std::uint64_t id=0;for(std::uint32_t bin=0;bin<seconds_day/s.config.demand_bin_virtual_s;++bin){const auto base=2+rng.bounded({RngDomain::TrafficOD,bin,0,0},5);for(std::uint32_t j=0;j<base;++j){auto from=NodeId{rng.bounded({RngDomain::TrafficOD,bin,1,j},static_cast<std::uint32_t>(s.nodes.size()))};auto to=NodeId{rng.bounded({RngDomain::TrafficOD,bin,2,j},static_cast<std::uint32_t>(s.nodes.size()))};if(from==to)to.value=(to.value+1)%s.nodes.size();auto route=router.route(from,to);if(route.found)s.trips.push_back({id++,bin*s.config.demand_bin_virtual_s+rng.bounded({RngDomain::TrafficOD,bin,3,j},s.config.demand_bin_virtual_s),from,to,std::move(route.edges)});}}std::sort(s.trips.begin(),s.trips.end(),[](auto&a,auto&b){return a.depart_virtual_s!=b.depart_virtual_s?a.depart_virtual_s<b.depart_virtual_s:a.id<b.id;});}
void ScenarioCompiler::plan_weather(Scenario&s,const DeterministicRng&rng)const{const auto f=s.config.dws_frequency;if(!f)return;std::vector<double>u(f);for(std::uint32_t i=0;i<f;++i)u[i]=rng.uniform01({RngDomain::DwsSchedule,i,0,0});std::stable_sort(u.begin(),u.end());const auto slack=double(s.config.playback_duration_s-5*(f-1));for(std::uint32_t i=0;i<f;++i){const auto playback=5*i+slack*u[i];const auto start=std::uint32_t(std::llround(playback/s.config.playback_duration_s*ppm_day));const auto duration=std::uint32_t((45+75*std::pow(rng.uniform01({RngDomain::DwsSchedule,i,1,0}),1.5))/1440.0*ppm_day);DwsEvent e;e.id={i+1};e.epicenter={rng.bounded({RngDomain::DwsSchedule,i,2,0},static_cast<std::uint32_t>(s.nodes.size()))};e.start_ppm=start;e.end_ppm=std::min(ppm_day,start+duration);e.intensity=.15+.85*std::pow(rng.uniform01({RngDomain::DwsSchedule,i,3,0}),1.7);const auto rmin=100.0,rmax=600.0;e.radius_m=rmin+(rmax-rmin)*rng.uniform01({RngDomain::DwsSchedule,i,4,0});e.flood_gain=.35+.6*rng.uniform01({RngDomain::DwsSchedule,i,5,0});e.recovery=.08+.15*rng.uniform01({RngDomain::DwsSchedule,i,6,0});s.dws_events.push_back(e);}}
void ScenarioCompiler::plan_incidents(Scenario&s,const DeterministicRng&rng)const{
    if(s.edges.empty()||s.nodes.empty())return;
    std::vector<EdgeId> eligible_edges;
    for(const auto&e:s.edges){if(is_source_direction_allowed(e))eligible_edges.push_back(e.id);}
    if(eligible_edges.empty())return;

    const std::uint32_t count=std::max<std::uint32_t>(s.config.min_incidents,std::max(4u,static_cast<std::uint32_t>(s.config.playback_duration_s/600)));
    s.incidents.reserve(count);
    const std::uint32_t day_span=seconds_day;

    for(std::uint32_t i=0;i<count;++i){
        double slot_min=0.08,slot_max=0.92;
        if(count>=3){
            if(i%3==0){slot_min=0.08;slot_max=0.35;}
            else if(i%3==1){slot_min=0.35;slot_max=0.65;}
            else{slot_min=0.65;slot_max=0.92;}
        }
        const double frac=slot_min+(slot_max-slot_min)*rng.uniform01({RngDomain::Incidents,i,0,0});
        const std::uint32_t start_s=static_cast<std::uint32_t>(frac*day_span);
        const std::uint32_t dur_s=900+rng.bounded({RngDomain::Incidents,i,1,0},1801);
        const std::uint32_t end_s=std::min(day_span,start_s+dur_s);

        const auto edge_idx=rng.bounded({RngDomain::Incidents,i,2,0},static_cast<std::uint32_t>(eligible_edges.size()));
        const auto edge_id=eligible_edges[edge_idx];
        const auto&edge=s.edges[edge_id.value];
        const auto node_id=edge.from;
        const auto type=static_cast<IncidentType>(rng.bounded({RngDomain::Incidents,i,3,0},5));

        Incident inc;
        inc.id=i+1;
        inc.type=type;
        inc.edge=edge_id;
        inc.node=node_id;
        inc.start_virtual_s=start_s;
        inc.end_virtual_s=end_s;

        switch(type){
        case IncidentType::RoadClosure:
            inc.speed_multiplier=0.0;
            inc.capacity_multiplier=0.0;
            inc.closed=true;
            inc.description="Emergency road closure: through-traffic prohibited on corridor";
            break;
        case IncidentType::Accident:
            inc.speed_multiplier=0.35;
            inc.capacity_multiplier=0.40;
            inc.closed=false;
            inc.description="Multi-vehicle collision: lane blocked, emergency services on scene";
            break;
        case IncidentType::Congestion:
            inc.speed_multiplier=0.45;
            inc.capacity_multiplier=0.50;
            inc.closed=false;
            inc.description="Severe localized congestion bottleneck with bumper-to-bumper queue";
            break;
        case IncidentType::VehicleBreakdown:
            inc.speed_multiplier=0.55;
            inc.capacity_multiplier=0.60;
            inc.closed=false;
            inc.description="Commercial transit vehicle breakdown obstructing right lane";
            break;
        case IncidentType::HazardSpill:
            inc.speed_multiplier=0.20;
            inc.capacity_multiplier=0.25;
            inc.closed=false;
            inc.description="Hazardous cargo spill: hazardous pavement conditions, severe speed reduction";
            break;
        }
        s.incidents.push_back(std::move(inc));
    }

    std::sort(s.incidents.begin(),s.incidents.end(),[](const Incident&a,const Incident&b){
        if(a.start_virtual_s!=b.start_virtual_s)return a.start_virtual_s<b.start_virtual_s;
        return a.id<b.id;
    });
}

void ScenarioCompiler::calculate_hashes(Scenario&s)const{
    const auto graph=canonical_graph(s);
    s.graph_hash="sha256:"+sha256(graph);
    std::ostringstream ev; ev<<"events-v2/"<<s.config.map_selection_version;
    for(const auto& p:s.signals){ev<<p.node.value<<','<<p.cycle_s<<','<<p.offset_s;for(auto phase:p.phases_s)ev<<','<<phase;}
    for(const auto& f:s.features)if(f.demand_type)ev<<f.id<<','<<static_cast<int>(*f.demand_type);
    for(const auto&e:s.dws_events)ev<<e.id.value<<','<<e.epicenter.value<<','<<e.start_ppm<<','<<e.end_ppm<<','<<std::llround(e.intensity*1e6)<<';';
    for(const auto&t:s.trips)ev<<t.id<<','<<t.depart_virtual_s<<','<<t.from.value<<','<<t.to.value<<';';
    for(const auto&inc:s.incidents)ev<<inc.id<<','<<static_cast<int>(inc.type)<<','<<inc.edge.value<<','<<inc.start_virtual_s<<','<<inc.end_virtual_s<<';';
    s.event_hash="sha256:"+sha256(ev.str());
    s.scenario_hash="sha256:"+sha256(s.seed.hex()+s.map_hash+s.graph_hash+s.event_hash+std::to_string(s.config.day));
}

void ScenarioCompiler::export_sumo(const Scenario&s,const std::filesystem::path&dir)const{
    std::filesystem::create_directories(dir);std::ofstream nod(dir/"network.nod.xml"),edg(dir/"network.edg.xml"),rou(dir/"sandbox.rou.xml"),add(dir/"sandbox.add.xml"),cfg(dir/"sandbox.sumocfg");
    if(!nod||!edg||!rou||!add||!cfg)throw std::runtime_error("cannot create SUMO bundle");
    nod<<"<nodes>\n";for(const auto&n:s.nodes)nod<<"  <node id=\"n"<<n.id.value<<"\" x=\""<<n.position.x_m<<"\" y=\""<<n.position.y_m<<"\" type=\""<<(n.signal?"traffic_light":"priority")<<"\"/>\n";nod<<"</nodes>\n";
    edg<<"<edges>\n";for(const auto&e:s.edges)if(is_source_direction_allowed(e))edg<<"  <edge id=\"e"<<e.id.value<<"\" from=\"n"<<e.from.value<<"\" to=\"n"<<e.to.value<<"\" numLanes=\""<<e.lanes<<"\" speed=\""<<e.free_speed_mps<<"\"/>\n";edg<<"</edges>\n";
    add<<"<additional>\n";for(const auto&b:s.bus_stops)add<<"  <busStop id=\"stop"<<b.id.value<<"\" lane=\"e"<<b.edge.value<<"_0\" startPos=\"1\" endPos=\""<<std::max(5.0,b.position_m)<<"\"/>\n";add<<"</additional>\n";
    rou<<"<routes>\n"
       <<"  <vType id=\"car\" accel=\"2.6\" decel=\"4.5\" sigma=\"0.2\" length=\"4.8\" maxSpeed=\"33.33\" vClass=\"passenger\" guiShape=\"passenger\"/>\n"
       <<"  <vType id=\"bus\" accel=\"1.4\" decel=\"3.5\" sigma=\"0.1\" length=\"12.0\" maxSpeed=\"20.0\" vClass=\"bus\" guiShape=\"bus\"/>\n"
       <<"  <vType id=\"van\" accel=\"2.0\" decel=\"4.0\" sigma=\"0.2\" length=\"6.5\" maxSpeed=\"25.0\" vClass=\"delivery\" guiShape=\"delivery\"/>\n";
    for(const auto&t:s.trips){
        if(t.route.empty())continue;
        const char* vtype = (t.id % 8 == 0) ? "bus" : ((t.id % 4 == 0) ? "van" : "car");
        rou<<"  <vehicle id=\"veh"<<t.id<<"\" type=\""<<vtype<<"\" depart=\""<<t.depart_virtual_s<<"\"><route edges=\"";
        for(std::size_t i=0;i<t.route.size();++i){if(i)rou<<' ';rou<<'e'<<t.route[i].value;}
        rou<<"\"/></vehicle>\n";
    }
    rou<<"</routes>\n";
    cfg<<"<configuration><input><net-file value=\"network.net.xml\"/><route-files value=\"sandbox.rou.xml\"/><additional-files value=\"sandbox.add.xml\"/></input><time><begin value=\"0\"/><end value=\"86400\"/><step-length value=\"1\"/></time><processing><time-to-teleport value=\"120\"/></processing><report><no-step-log value=\"true\"/></report></configuration>\n";
}
} // namespace dstns
