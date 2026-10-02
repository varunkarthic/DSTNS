// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/calendar.hpp"
#include "dstns/events.hpp"
#include "dstns/engine.hpp"
#include "dstns/osm.hpp"
#include <chrono>
#include <thread>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <numeric>
#include <stdexcept>
using namespace dstns;
void check(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
int main(){try{
    ScenarioConfig cfg;cfg.playback_duration_s=3600;cfg.grid_width=20;cfg.grid_height=20;
    ScenarioCompiler compiler;auto seed=Seed128::parse("0x12345678");auto s=compiler.compile(seed,cfg);
    // The day type is the seed's unless configured (it was a fixed weekday
    // before the deterministic calendar).
    check(s.config.day==derive_day_type(seed)&&s.day_source=="seed","day type derived from the seed by default");
    // The checks below describe a weekday (school and office peaks), so they
    // name one rather than relying on what this seed happens to derive.
    cfg.day=0;s=compiler.compile(seed,cfg);check(s.config.day==0&&s.day_source=="configured","a configured day type is used and recorded");
    EventRuntime a,b;a.initialize(s);b.initialize(s);
    check(a.inspect(true,"all",0,200)==b.inspect(true,"all",0,200),"same deterministic queue");
    check(a.signals.size()>1,"signal fixture");
    // A planned offset can round up to a whole cycle; it must wrap to the
    // start of the cycle rather than walk past the last phase.
    {auto wrapped=s;for(auto& plan:wrapped.signals)plan.offset_s=plan.cycle_s;EventRuntime w;w.initialize(wrapped);
     for(const auto& state:w.signals)check(state.phase<6&&state.next_transition>0,"offset of a whole cycle wraps to phase 0");}
    bool independent=false;for(auto& state:a.signals)if(state.next_transition!=a.signals.front().next_transition)independent=true;check(independent,"independent offsets");
    for(const auto& plan:s.signals){check(plan.cycle_s>=50&&plan.cycle_s<=120,"bounded cycles");check(std::accumulate(plan.phases_s.begin(),plan.phases_s.end(),0)==plan.cycle_s,"exact phases");check(plan.phases_s[0]>=12&&plan.phases_s[3]>=12,"safe minimum greens");}
    for(unsigned t=1;t<3600;++t){(void)a.advance(s,t);if(t%73==0)(void)b.advance(s,t);for(const auto& state:a.signals){check(state.phase<6&&state.next_transition>t,"valid transitions");}}
    (void)b.advance(s,3599);check(a.signal_json(s,3599)==b.signal_json(s,3599),"scheduler independent of polling frequency");
    auto saved=a;(void)a.advance(s,5000);a=saved;check(a.inspect(false,"all",0,30)==saved.inspect(false,"all",0,30),"checkpoint event history copy");
    check(a.inspect(false,"all",0,200)["items"].size()<=200,"bounded observation page");
    (void)a.advance(s,32000);bool demand=false;for(const auto& e:s.edges)if(a.demand_effect(e.id)>0)demand=true;check(demand,"POI demand affects network");
    CongestionTracker c;std::vector<EdgeDynamic> edges(s.edges.size());for(auto& e:edges)e.congestion=.5;c.update(s,edges,1,1);check(std::abs(c.current-50)<1e-9,"weighted index");for(auto& e:edges)e.congestion=1;c.update(s,edges,2,1);check(c.average>50&&c.average<100,"EMA progresses");check(c.current==100,"bounded index");
    Scenario weighted;EdgeStatic e1,e2;e1.id={0};e1.length_m=100;e1.lanes=1;e2.id={1};e2.length_m=300;e2.lanes=2;weighted.edges={e1,e2};std::vector<EdgeDynamic> values(2);values[1].congestion=1;CongestionTracker wc;wc.update(weighted,values,1,1);check(std::abs(wc.current-600.0/7)<1e-8,"length lanes weights");
    weighted.edges[1].synthetic_reverse=true;wc.update(weighted,values,2,1);check(wc.current==0,"synthetic directions excluded");
    const auto dir=std::filesystem::temp_directory_path()/"dstns-modern-test";RuntimeLogger logger(dir);SimulationEngine engine(logger);cfg.grid_width=6;cfg.grid_height=6;engine.prepare(seed,cfg);engine.seek(32000,false);auto normal=engine.snapshot()["data"];engine.seek(0,false);engine.set_tick_rate(5);engine.seek(32000,false);check(normal==engine.snapshot()["data"],"speed does not change physics or event state");engine.seek(33000,false);engine.seek(32000,false);check(normal==engine.snapshot()["data"],"rewind restores EMA and scheduler");const auto signal_node=engine.snapshot()["data"]["signals"][0]["junction_id"].get<unsigned>();engine.toggle_signal(NodeId{signal_node},1);auto overrides=engine.catalog("signals")["data"]["items"];bool found_override=false;for(auto& signal:overrides)if(signal["junction_id"]==signal_node){found_override=signal["manual_override"]==true&&signal["group_a"]=="green"&&signal["next_transition_at"].is_null();}check(found_override,"manual controller state remains truthful");engine.terminate();
    auto begin=std::chrono::steady_clock::now();auto map=OsmRoadLoader{}.load_xml("data/fixtures/real_network.osm.xml",50000,DeterministicRng(seed.derive("map")));
    check(map.nodes.size()>=1000,"large real region");check(!map.features.empty(),"OSM features");bool named=false,polygon=false;for(auto& e:map.edges)if(!e.name.empty())named=true;for(auto& f:map.features)if(f.polygon)polygon=true;check(named&&polygon,"road names and footprints");
    auto& p=map.nodes.front().position;check(std::abs(p.x_m-(p.lon-map.projection_lon)*111320*std::cos(map.projection_lat*3.141592653589793/180))<1e-5,"projection invariant");
    std::cout<<"OSM: "<<map.nodes.size()<<" nodes, "<<map.features.size()<<" features in "<<std::chrono::duration<double>(std::chrono::steady_clock::now()-begin).count()<<"s\n";
    // Stress one pending transition per controller, independent of browser transport.
    Scenario large=s;large.signals.clear();for(unsigned i=0;i<10000;++i)large.signals.push_back({NodeId{i%unsigned(s.nodes.size())},60,{26,3,1,26,3,1},std::uint16_t(i%60)});
    EventRuntime stress;begin=std::chrono::steady_clock::now();stress.initialize(large);(void)stress.advance(large,300);check(stress.executed_count>100000,"large event volume");check(stress.inspect(false,"all",0,30)["items"].size()==30,"bounded history transport");std::cout<<"10k controllers / "<<stress.executed_count<<" executions: "<<std::chrono::duration<double>(std::chrono::steady_clock::now()-begin).count()<<"s\n";
    // Quitting must not queue behind a long operation.
    //
    // A scenario compile holds the engine lock for its whole duration, and a
    // compile that downloads a city extract holds it for tens of seconds. An
    // operator who has asked to quit should not wait that out, so the request
    // is lock-free: it is exercised here with the lock deliberately held.
    {
        const auto dir=std::filesystem::temp_directory_path()/"dstns-terminate-test";
        RuntimeLogger tl(dir);
        SimulationEngine te(tl);
        check(!te.terminating(),"a fresh engine is not terminating");

        // Occupy the engine the way a compile does, then ask it to quit.
        std::atomic<bool> holding{false}, release{false};
        std::thread occupier([&]{
            ScenarioConfig busy;busy.osm_file="data/fixtures/real_network.osm.xml";
            busy.playback_duration_s=3600;busy.max_nodes=50000;
            holding=true;
            try{(void)te.prepare(Seed128::parse("0xfeed"),busy);}catch(...){}
            release=true;
        });
        while(!holding)std::this_thread::yield();

        const auto asked=std::chrono::steady_clock::now();
        te.request_terminate();
        const auto waited=std::chrono::duration<double>(std::chrono::steady_clock::now()-asked).count();
        check(te.terminating(),"the request is recorded immediately");
        check(waited<0.5,"the request returns without waiting for the engine lock");
        te.request_terminate();
        check(te.terminating(),"asking twice is harmless");

        occupier.join();
        te.terminate();
        std::filesystem::remove_all(dir);
    }

    std::cout<<"Modernization invariants passed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
