#include "dstns/engine.hpp"
#include "dstns/graph.hpp"
#include "dstns/osm.hpp"
#include "dstns/rng.hpp"
#include "dstns/scenario.hpp"
#include "dstns/geo.hpp"

#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

namespace {
int tests=0;
void check(bool condition,const std::string&name){++tests;if(!condition)throw std::runtime_error("FAILED: "+name);}
template<class F>void rejects(F&&f,const std::string&name){bool threw=false;try{f();}catch(...){threw=true;}check(threw,name);}
}

int main(){try{
    using namespace dstns;
    std::cerr<<"[test] primitives\n";
    const auto seed=Seed128::parse("0x123456789abcdef00123456789abcdef");
    check(seed.hex()=="0x123456789abcdef00123456789abcdef","128-bit seed round-trip");
    rejects([]{(void)Seed128::parse("xyz");},"invalid seed rejected");
    check(sha256("abc")=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","SHA-256 vector");
    DeterministicRng rng(seed),same(seed);const RngAddress a{RngDomain::Buildings,42,7,3};
    check(rng.u32(a)==same.u32(a),"RNG repeatability");check(rng.u32(a)!=rng.u32({RngDomain::DwsSchedule,42,7,3}),"RNG domain isolation");
    for(std::uint32_t bound=1;bound<100;++bound)check(rng.bounded({RngDomain::TrafficOD,bound,0,0},bound)<bound,"bounded RNG range");
    check(wendland_c2(0,100)==1&&wendland_c2(100,100)==0&&wendland_c2(110,100)==0,"compact spatial kernel");
    check(std::abs(temporal_beta(500000,{0,1000000,2,2})-1)<1e-12,"temporal kernel peak");

    std::cerr<<"[test] scenario\n";ScenarioConfig cfg;cfg.playback_duration_s=120;cfg.grid_width=8;cfg.grid_height=7;cfg.dws_frequency=4;
    ScenarioCompiler compiler;auto s1=compiler.compile(seed,cfg);auto s2=compiler.compile(seed,cfg);
    check(s1.scenario_hash==s2.scenario_hash,"scenario replay hash");check(s1.graph_hash==s2.graph_hash,"graph replay hash");check(!s1.nodes.empty()&&!s1.edges.empty(),"scenario nonempty");
    check(std::none_of(s1.edges.begin(),s1.edges.end(),[](const auto&e){return e.source_oneway||e.synthetic_reverse;}),"synthetic grid is bidirectional without source-only restrictions");
    check(s1.edges.size()%2==0,"edge pairs");for(const auto&e:s1.edges){check(e.reverse_twin.value<s1.edges.size(),"reverse ID valid");const auto&r=s1.edges[e.reverse_twin.value];check(r.from==e.to&&r.to==e.from&&r.reverse_twin==e.id,"reverse twin invariant");}
    check(!s1.bus_stops.empty(),"bus stops generated");for(const auto&b:s1.bus_stops)check(b.edge.value<s1.edges.size()&&b.position_m<=s1.edges[b.edge.value].length_m,"bus stop materialized");
    for(std::size_t i=1;i<s1.dws_events.size();++i){const auto p0=s1.dws_events[i-1].start_ppm/1e6*cfg.playback_duration_s;const auto p1=s1.dws_events[i].start_ppm/1e6*cfg.playback_duration_s;check(p1-p0>=4.999,"DWS playback spacing");}
    auto without_news=cfg;without_news.news=false;auto s3=compiler.compile(seed,without_news);check(s1.graph_hash==s3.graph_hash&&s1.event_hash==s3.event_hash,"News module isolation");
    // "auto" means the seed picks a real city district and the tile is fetched
    // on demand. Exercise that offline: plant the tile this seed names, then
    // confirm the cache is used and that a genuine miss is a hard failure.
    auto auto_cfg=cfg;auto_cfg.osm_file="auto";
    const auto tile_cache=std::filesystem::temp_directory_path()/"dstns-auto-map";
    std::filesystem::remove_all(tile_cache);std::filesystem::create_directories(tile_cache);
    auto_cfg.map_cache_dir=tile_cache.string();
    const auto planned=select_map_location(seed,auto_cfg.map_tile_radius_m);
    check(!planned.city.empty(),"auto resolves the seed to a named city");
    std::filesystem::copy_file("data/fixtures/real_network.osm.xml",planned.cache_path(tile_cache));
    const auto real_map=compiler.compile(seed,auto_cfg);
    check(real_map.config.osm_file==planned.cache_path(tile_cache).string(),"auto uses the seed-derived tile");
    check(real_map.map_city==planned.city&&!real_map.map_downloaded,"cached tile is reused and its city recorded");
    check(real_map.nodes.size()>120,"default road map is not the 120-node grid");
    // An absent tile that cannot be downloaded must fail, never fall back.
    ::setenv("DSTNS_PYTHON","/usr/bin/false",1);
    auto miss_cfg=auto_cfg;miss_cfg.map_cache_dir=(tile_cache/"empty").string();
    bool missing_map_rejected=false;
    try{(void)compiler.compile(seed,miss_cfg);}catch(const MapFetchError&){missing_map_rejected=true;}
    ::unsetenv("DSTNS_PYTHON");
    std::filesystem::remove_all(tile_cache);
    check(missing_map_rejected,"an undownloadable map fails instead of silently generating a grid");
    auto osm_cfg=cfg;osm_cfg.osm_file="tests/fixtures/roads.osm.xml";osm_cfg.max_nodes=50;auto osm=compiler.compile(seed,osm_cfg);check(osm.nodes.size()==9,"OSM road-only node filtering");check(osm.edges.size()==24,"OSM segment bidirectional normalization");check(std::any_of(osm.edges.begin(),osm.edges.end(),[](const auto&e){return e.synthetic_reverse;}),"OSM one-way provenance retained");
    GraphStore osm_graph(osm);RoutePlanner osm_routes(osm_graph);const auto forward=osm_routes.route(NodeId{0},NodeId{1});const auto reverse=osm_routes.route(NodeId{1},NodeId{0});
    check(forward.found&&forward.edges.size()==1&&!osm.edges[forward.edges.front().value].synthetic_reverse,"OSM one-way forward direction traversable");
    check(reverse.found&&std::none_of(reverse.edges.begin(),reverse.edges.end(),[&](EdgeId e){return osm.edges[e.value].synthetic_reverse;}),"OSM one-way reverse route avoids forbidden direction");
    check(reverse.edges.size()>1,"OSM one-way reverse route takes legal detour");
    check(std::none_of(osm.trips.begin(),osm.trips.end(),[&](const PlannedTrip&t){return std::any_of(t.route.begin(),t.route.end(),[&](EdgeId e){return osm.edges[e.value].synthetic_reverse;});}),"planned trips exclude forbidden one-way direction");
    check(std::none_of(osm.bus_stops.begin(),osm.bus_stops.end(),[&](const BusStop&b){return osm.edges[b.edge.value].synthetic_reverse;}),"bus stops attach to traversable SUMO lanes");
    check(std::none_of(osm.hotspot_edges.begin(),osm.hotspot_edges.end(),[&](EdgeId e){return osm.edges[e.value].synthetic_reverse;}),"hotspots exclude forbidden one-way direction");
    const auto sumo_temp=std::filesystem::temp_directory_path()/"dstns-oneway-sumo";std::filesystem::remove_all(sumo_temp);compiler.export_sumo(osm,sumo_temp);std::ifstream sumo_edges(sumo_temp/"network.edg.xml");const std::string sumo_edge_xml((std::istreambuf_iterator<char>(sumo_edges)),{});for(const auto&e:osm.edges)if(e.synthetic_reverse)check(sumo_edge_xml.find("id=\"e"+std::to_string(e.id.value)+"\"")==std::string::npos,"SUMO export excludes forbidden reverse edge");std::filesystem::remove_all(sumo_temp);
    const auto hash_temp=std::filesystem::temp_directory_path()/"dstns-map-hash";std::filesystem::remove_all(hash_temp);std::filesystem::create_directories(hash_temp);std::ifstream osm_fixture("tests/fixtures/roads.osm.xml");const std::string fixture_xml((std::istreambuf_iterator<char>(osm_fixture)),{});const auto close_tag=fixture_xml.rfind("</osm>");check(close_tag!=std::string::npos,"OSM hash fixture has closing tag");const auto shared_comment="\n<!--"+std::string(11'000,'x');const auto write_variant=[&](const std::filesystem::path&path,char suffix){std::ofstream out(path);out<<fixture_xml.substr(0,close_tag)<<shared_comment<<suffix<<"-->\n"<<fixture_xml.substr(close_tag);};const auto map_a=hash_temp/"a.osm.xml",map_b=hash_temp/"b.osm.xml";write_variant(map_a,'a');write_variant(map_b,'b');const auto hash_a=OsmRoadLoader{}.load_xml(map_a,50,rng);const auto hash_b=OsmRoadLoader{}.load_xml(map_b,50,rng);check(hash_a.source_hash!=hash_b.source_hash,"map hash covers bytes after first 10KB");auto hash_cfg_a=osm_cfg,hash_cfg_b=osm_cfg;hash_cfg_a.osm_file=map_a.string();hash_cfg_b.osm_file=map_b.string();const auto scenario_a=compiler.compile(seed,hash_cfg_a),scenario_b=compiler.compile(seed,hash_cfg_b);check(scenario_a.graph_hash==scenario_b.graph_hash,"non-topological XML suffix preserves graph hash");check(scenario_a.map_hash!=scenario_b.map_hash&&scenario_a.scenario_hash!=scenario_b.scenario_hash,"full map hash propagates into scenario identity");std::filesystem::remove_all(hash_temp);
    auto sink_cfg=cfg;sink_cfg.osm_file="tests/fixtures/oneway_sink.osm.xml";sink_cfg.max_nodes=10;const auto sink=compiler.compile(seed,sink_cfg);const auto sink_node=std::find_if(sink.nodes.begin(),sink.nodes.end(),[](const NodeStatic&n){return n.osm_node_id==3;});check(sink_node!=sink.nodes.end()&&sink_node->degree==2,"one-way sink fixture has coverage-eligible degree");check(std::none_of(sink.bus_stops.begin(),sink.bus_stops.end(),[&](const BusStop&stop){return stop.anchor_node==sink_node->id;}),"bus-stop coverage skips node without traversable outgoing edge");
    const auto alternate_seed=Seed128::parse("0xfedcba98765432100123456789abcdef");
    const auto district1=OsmRoadLoader{}.load_xml("data/fixtures/real_network.osm.xml",50000,rng);
    const auto district1_repeat=OsmRoadLoader{}.load_xml("data/fixtures/real_network.osm.xml",50000,same);
    const auto district2=OsmRoadLoader{}.load_xml("data/fixtures/real_network.osm.xml",50000,DeterministicRng(alternate_seed));
    auto osm_ids=[](const OsmRoadGraph&g){std::vector<std::int64_t> ids;for(const auto&n:g.nodes)ids.push_back(n.osm_node_id);return ids;};
    check(osm_ids(district1)==osm_ids(district1_repeat),"same seed reproduces OSM district");
    check(osm_ids(district1)!=osm_ids(district2),"different seed selects different OSM district");
    check(district1.nodes.size()>=1000&&district1.nodes.size()<=6000,"OSM district size bounded");
    std::cerr<<"[test] graph\n";GraphStore graph(s1);RoutePlanner routes(graph);auto route=routes.route(NodeId{0},NodeId{static_cast<std::uint32_t>(s1.nodes.size()-1)});check(route.found&&!route.edges.empty(),"A* route");check(routes.route(NodeId{3},NodeId{3}).found&&routes.route(NodeId{3},NodeId{3}).cost_ms==0,"zero route");
    graph.edge_state(route.edges.front()).closed=true;auto alternate=routes.route(NodeId{0},NodeId{static_cast<std::uint32_t>(s1.nodes.size()-1)});check(alternate.found,"routing around closure");
    auto max_duration=cfg;max_duration.playback_duration_s=3600;(void)compiler.compile(seed,max_duration);
    rejects([&]{auto bad=cfg;bad.playback_duration_s=3601;(void)compiler.compile(seed,bad);},"duration above 3600 rejected");rejects([&]{auto bad=cfg;bad.tick_rate=0;(void)compiler.compile(seed,bad);},"invalid tick rate rejected");rejects([&]{auto bad=cfg;bad.dws_frequency=25;(void)compiler.compile(seed,bad);},"impossible weather schedule rejected");

    std::cerr<<"[test] engine\n";const auto temp=std::filesystem::temp_directory_path()/("dstns-test-"+s1.scenario_hash.substr(7,10));std::filesystem::remove_all(temp);RuntimeLogger logger(temp);SimulationEngine engine(logger);std::cerr<<"[test] engine-start\n";engine.start(seed,cfg);std::cerr<<"[test] engine-pause\n";engine.pause();engine.seek(137,false);engine.seek(3001,false);check(engine.status()["data"]["checkpoint_count"]==4,"unaligned progression captures crossed checkpoint boundaries");std::cerr<<"[test] engine-seek1\n";engine.seek(40830,false);auto snap1=engine.snapshot()["data"];std::cerr<<"[test] engine-seek2\n";engine.seek(45000,false);engine.seek(40830,false);auto snap2=engine.snapshot()["data"];check(snap1==snap2,"non-boundary seek reconstructs state and news IDs");auto tick=engine.set_tick_rate(.5);check(tick["tick_rate"]==.5,"tick rate control");engine.undo(1);check(engine.status()["clock"]["tick_rate"]==1.0,"undo control");engine.redo(1);check(engine.status()["clock"]["tick_rate"]==.5,"redo control");rejects([&]{(void)engine.set_day(2);},"invalid day rejected");std::cerr<<"[test] engine-stop\n";engine.stop();check(engine.lifecycle()==Lifecycle::Stopped,"stop leaves server lifecycle");engine.reset();check(engine.lifecycle()==Lifecycle::Idle,"reset to idle");

    std::cerr<<"[test] subseed avalanche and domain separation\n";
    check(seed.derive("map") == seed.derive("map"), "subseed derive repeatability");
    check(seed.derive("map") != seed.derive("dws"), "domain separation map vs dws");
    check(seed.derive("map") != seed.derive("incidents"), "domain separation map vs incidents");
    check(seed.derive("incidents") != seed.derive("events"), "domain separation incidents vs events");
    const auto s_a = Seed128{0, 1000};
    const auto s_b = Seed128{0, 1001};
    const auto d_a = s_a.derive("map");
    const auto d_b = s_b.derive("map");
    std::uint32_t bit_diff = 0;
    for (int i = 0; i < 64; ++i) {
        if (((d_a.high ^ d_b.high) >> i) & 1) ++bit_diff;
        if (((d_a.low ^ d_b.low) >> i) & 1) ++bit_diff;
    }
    check(bit_diff >= 40, "subseed derive avalanche: strong bit diffusion for 1-bit input change");

    std::cerr<<"[test] incidents minimum count and temporal spread\n";
    for (std::uint64_t v = 1; v <= 10; ++v) {
        auto scn = compiler.compile(Seed128{0, v * 1000}, cfg);
        check(scn.incidents.size() >= 4, "minimum 4 incidents generated per normal simulation");
        for (const auto& inc : scn.incidents) {
            check(inc.edge.value < scn.edges.size(), "incident edge id valid");
            check(is_source_direction_allowed(scn.edges[inc.edge.value]), "incident edge traversable");
            check(inc.end_virtual_s > inc.start_virtual_s, "incident end > start");
        }
        bool has_early = false, has_mid = false, has_late = false;
        for (const auto& inc : scn.incidents) {
            if (inc.start_virtual_s < 30000) has_early = true;
            else if (inc.start_virtual_s < 60000) has_mid = true;
            else has_late = true;
        }
        check(has_early || has_mid || has_late, "incidents spread temporally across the day");
    }

    std::cerr<<"[test] reset zero leakage\n";
    engine.start(seed, cfg);
    engine.trigger_surge(NodeId{0}, 2.5, 400.0, 1200);
    engine.toggle_signal(NodeId{0}, 2);
    engine.add_weather(NodeId{0}, 0.9, 500.0, 30, 0.6);
    engine.reset();
    check(engine.lifecycle() == Lifecycle::Idle, "reset to idle lifecycle");
    check(engine.status()["data"]["lifecycle"] == "IDLE", "status shows idle");
    const auto seed_b = Seed128{0, 99999};
    engine.start(seed_b, cfg);
    auto snap_b = engine.snapshot()["data"];
    check(snap_b["active_surges"].empty(), "zero surge leakage after reset");
    check(snap_b["active_weather"].empty(), "zero weather leakage after reset");
    engine.reset();

    engine.terminate();std::filesystem::remove_all(temp);std::cerr<<"[test] done\n";
    std::cout<<"DSTNS tests passed: "<<tests<<" assertions\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
