#include "dstns/engine.hpp"
#include "dstns/graph.hpp"
#include "dstns/rng.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <filesystem>
#include <iostream>
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
    check(s1.edges.size()%2==0,"edge pairs");for(const auto&e:s1.edges){check(e.reverse_twin.value<s1.edges.size(),"reverse ID valid");const auto&r=s1.edges[e.reverse_twin.value];check(r.from==e.to&&r.to==e.from&&r.reverse_twin==e.id,"reverse twin invariant");}
    check(!s1.bus_stops.empty(),"bus stops generated");for(const auto&b:s1.bus_stops)check(b.edge.value<s1.edges.size()&&b.position_m<=s1.edges[b.edge.value].length_m,"bus stop materialized");
    for(std::size_t i=1;i<s1.dws_events.size();++i){const auto p0=s1.dws_events[i-1].start_ppm/1e6*cfg.playback_duration_s;const auto p1=s1.dws_events[i].start_ppm/1e6*cfg.playback_duration_s;check(p1-p0>=4.999,"DWS playback spacing");}
    auto without_news=cfg;without_news.news=false;auto s3=compiler.compile(seed,without_news);check(s1.graph_hash==s3.graph_hash&&s1.event_hash==s3.event_hash,"News module isolation");
    auto osm_cfg=cfg;osm_cfg.osm_file="tests/fixtures/roads.osm.xml";osm_cfg.max_nodes=50;auto osm=compiler.compile(seed,osm_cfg);check(osm.nodes.size()==9,"OSM road-only node filtering");check(osm.edges.size()==24,"OSM segment bidirectional normalization");check(std::any_of(osm.edges.begin(),osm.edges.end(),[](const auto&e){return e.synthetic_reverse;}),"OSM one-way provenance retained");
    std::cerr<<"[test] graph\n";GraphStore graph(s1);RoutePlanner routes(graph);auto route=routes.route(NodeId{0},NodeId{static_cast<std::uint32_t>(s1.nodes.size()-1)});check(route.found&&!route.edges.empty(),"A* route");check(routes.route(NodeId{3},NodeId{3}).found&&routes.route(NodeId{3},NodeId{3}).cost_ms==0,"zero route");
    graph.edge_state(route.edges.front()).closed=true;auto alternate=routes.route(NodeId{0},NodeId{static_cast<std::uint32_t>(s1.nodes.size()-1)});check(alternate.found,"routing around closure");
    rejects([&]{auto bad=cfg;bad.tick_rate=0;(void)compiler.compile(seed,bad);},"invalid tick rate rejected");rejects([&]{auto bad=cfg;bad.dws_frequency=25;(void)compiler.compile(seed,bad);},"impossible weather schedule rejected");

    std::cerr<<"[test] engine\n";const auto temp=std::filesystem::temp_directory_path()/("dstns-test-"+s1.scenario_hash.substr(7,10));std::filesystem::remove_all(temp);RuntimeLogger logger(temp);SimulationEngine engine(logger);std::cerr<<"[test] engine-start\n";engine.start(seed,cfg);std::cerr<<"[test] engine-pause\n";engine.pause();std::cerr<<"[test] engine-seek1\n";auto first=engine.seek(3600,false);(void)first;auto snap1=engine.snapshot()["data"];std::cerr<<"[test] engine-seek2\n";engine.seek(7200,false);engine.seek(3600,false);auto snap2=engine.snapshot()["data"];check(snap1==snap2,"checkpoint seek reconstruction");auto tick=engine.set_tick_rate(.5);check(tick["tick_rate"]==.5,"tick rate control");engine.undo(1);check(engine.status()["clock"]["tick_rate"]==1.0,"undo control");engine.redo(1);check(engine.status()["clock"]["tick_rate"]==.5,"redo control");rejects([&]{(void)engine.set_day(2);},"invalid day rejected");std::cerr<<"[test] engine-stop\n";engine.stop();check(engine.lifecycle()==Lifecycle::Stopped,"stop leaves server lifecycle");engine.reset();check(engine.lifecycle()==Lifecycle::Idle,"reset to idle");engine.terminate();std::filesystem::remove_all(temp);std::cerr<<"[test] done\n";
    std::cout<<"DSTNS tests passed: "<<tests<<" assertions\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
