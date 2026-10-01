// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Deterministic slow-map I/O: hold a FIFO open, exercise concurrent observers,
// then release real OSM bytes. No internet, sleeps for download duration, or mocks
// of the engine's locking and installation path.
#include "dstns/engine.hpp"
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <thread>
using namespace dstns;
using namespace std::chrono_literals;
namespace {
int failures = 0;
void check(bool ok, const char* text) { if (!ok) { ++failures; std::cerr << "FAIL: " << text << '\n'; } }
struct SlowMap {
    std::filesystem::path path;
    int fd{-1};
    explicit SlowMap(std::filesystem::path p): path(std::move(p)) {
        std::filesystem::remove(path);
        if (::mkfifo(path.c_str(), 0600) != 0) throw std::runtime_error("mkfifo failed");
        fd = ::open(path.c_str(), O_RDWR);
        if (fd < 0) throw std::runtime_error("open FIFO failed");
    }
    void release() {
        if (fd < 0) return;
        std::ifstream input("tests/fixtures/roads.osm.xml");
        const std::string xml((std::istreambuf_iterator<char>(input)), {});
        if (::write(fd, xml.data(), xml.size()) != static_cast<ssize_t>(xml.size())) throw std::runtime_error("write FIFO failed");
        ::close(fd); fd = -1;
    }
    ~SlowMap() { if(fd >= 0) ::close(fd); std::filesystem::remove(path); }
};
void wait_build(SimulationEngine& e) {
    for (int i=0; i<1000 && e.preparation_stage() != "building"; ++i) std::this_thread::sleep_for(1ms);
    check(e.preparation_stage() == "building", "compile reached controlled slow I/O");
}
std::string attempt(auto&& fn) { try { fn(); return "ok"; } catch (const std::exception& e) { return e.what(); } }
}
int main() {
    auto dir=std::filesystem::temp_directory_path()/("dstns-loading-"+std::to_string(::getpid()));
    std::filesystem::create_directories(dir);
    RuntimeLogger logger(dir);
    const auto seed=Seed128::parse("0x12345");
    ScenarioConfig cfg; cfg.playback_duration_s=3600; cfg.osm_file=(dir/"slow.osm.xml").string();
    for (bool standby : {false,true}) {
        SimulationEngine engine(logger); SlowMap map(cfg.osm_file);
        auto compile=std::async(std::launch::async,[&]{return attempt([&]{if(standby)engine.prepare(seed,cfg);else engine.start(seed,cfg);});});
        wait_build(engine);
        auto status=std::async(std::launch::async,[&]{return engine.status();});
        const bool responsive=status.wait_for(200ms)==std::future_status::ready;
        check(responsive,"observer status responds while map data has not arrived");
        if(responsive) check(status.get()["data"]["lifecycle"]=="PREPARING","pending world is reported truthfully");
        map.release();
        check(compile.get()=="ok","map loads after observers opened during compile");
        check(engine.topology()["data"]["nodes"].size()>0,"real OSM topology installed");
    }
    for (bool regenerate : {false,true}) for (bool terminate : {false,true}) {
        SimulationEngine engine(logger);
        if(regenerate) { std::filesystem::copy_file("tests/fixtures/roads.osm.xml",cfg.osm_file,std::filesystem::copy_options::overwrite_existing); engine.start(seed,cfg); }
        SlowMap map(cfg.osm_file);
        std::future<std::string> compile;
        if(regenerate) engine.regenerate_world();
        else compile=std::async(std::launch::async,[&]{return attempt([&]{engine.start(seed,cfg);});});
        wait_build(engine);
        auto cancel=std::async(std::launch::async,[&]{if(terminate)engine.terminate();else engine.reset();});
        check(cancel.wait_for(200ms)==std::future_status::ready,"reset and terminate do not wait for map I/O");
        map.release(); cancel.get();
        if(compile.valid()) (void)compile.get();
        for(int i=0;i<2000&&engine.world_generating();++i)std::this_thread::sleep_for(1ms);
        check(!engine.world_generating(),"cancelled regeneration settles");
        check(engine.status()["data"]["lifecycle"]==(terminate?"TERMINATING":"IDLE"),"late map cannot revive cancelled world");
        if(regenerate) check(engine.world_status()["data"]["state"]=="failed","cancelled replacement reports failure");
    }
    std::filesystem::remove_all(dir);
    std::cout << "Loading concurrency: " << failures << " failures\n";
    return failures?1:0;
}
