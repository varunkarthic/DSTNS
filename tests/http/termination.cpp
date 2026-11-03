// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Session termination against a real server: once running, and once with a download stalled in flight, asked to end
// through the API and by a signal.
#include "harness.hpp"

#include <atomic>
#include <set>

using namespace check;

namespace {

// Each process: its parent.
std::map<int, int> processes() {
    std::map<int, int> table;
    std::istringstream rows(run({"ps", "-axo", "pid=,ppid="}).output);
    for (int pid, parent; rows >> pid >> parent;) table[pid] = parent;
    return table;
}

std::set<int> descendants(int pid) {
    const auto table = processes();
    std::set<int> found{pid};
    for (bool more = true; more;) {
        more = false;
        for (const auto& [child, parent] : table) {
            if (found.contains(parent) && found.insert(child).second) more = true;
        }
    }
    found.erase(pid);
    return found;
}

std::set<int> still_alive(const std::set<int>& pids) {
    std::set<int> alive;
    const auto table = processes();
    for (int pid : pids) {
        if (table.contains(pid)) alive.insert(pid);
    }
    return alive;
}

void session(bool downloading, bool signalled = false) {
    std::atomic<bool> entered = false, gate = false;
    Upstream upstream;
    upstream.http.Post(".*", [&](const httplib::Request&, httplib::Response& res) {
        entered = true;
        for (const double end = now() + 20; !gate && now() < end;) delay(0.02);
        res.status = 503;
    });
    upstream.start();
    TempDir tmp("dstns-termination-");
    std::set<int> children;
    {
        Server server(tmp.path, {"--maps", tmp.str(), "--map-cache", "keep"}, {{"DSTNS_OVERPASS_ENDPOINTS", upstream.url()}});
        json config{{"seed", "723921"}, {"map", downloading ? json{{"cache_dir", tmp.str()}} : json{{"osm_file", (root() / "tests/fixtures/roads.osm.xml").string()}}}};
        server.op("POST", "/api/v1/playback/start", config, 2);
        if (downloading) {
            until([&] { return entered.load(); }, 8, "the real downloader to reach the slow upstream");
            children = descendants(server.process.pid);
            EXPECT(!children.empty(), "a downloader child actually exists");
            EXPECT(server.op("GET", "/api/v1/playback/status").data().at("lifecycle") == "PREPARING");
        } else {
            until([&] { return server.op("GET", "/api/v1/playback/status", none, 2).data().at("lifecycle") == "RUNNING"; }, 12, "the run");
        }
        if (signalled) {
            ::kill(server.process.pid, SIGTERM);
            EXPECT(server.process.wait(6) == 128 + SIGTERM, "ended by the signal", server.process.status);
        } else {
            EXPECT(server.op("POST", "/api/v1/system/terminate", json::object(), 2).body.at("ok") == true);
            EXPECT(server.process.wait(6) == 0, server.process.status);
        }
        until([&] { return still_alive(children).empty(); }, 12, "the downloader to stop");
        bool unreachable = false;
        try {
            server.call("GET", "/health", none, "", {}, 2);
        } catch (const Unreachable&) {
            unreachable = true;
        }
        EXPECT(unreachable, "the server stopped listening");
    }
    gate = true;
    // Cleanup is limited to processes proven to belong to this test.
    for (int pid : still_alive(children)) ::kill(pid, SIGKILL);
}

} // namespace

int main() {
    session(false);
    session(true);
    session(true, true);
    std::cout << "termination ok: a running session, and one with a download in flight, through the API and by SIGTERM\n";
}
