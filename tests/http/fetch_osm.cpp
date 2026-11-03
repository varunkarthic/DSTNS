// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The map downloader, `dstns_server --fetch-osm`, against a local Overpass.
//
// A single volunteer-run Overpass mirror refusing connections, shedding load or timing out must not end a run, so the
// fetcher fails over between mirrors. These tests stand up their own endpoints: a closed port, a mirror that rate
// limits, and one that serves a map, and check what the operator is told when none of them answers.
#include "harness.hpp"
#include "support.hpp"

#include <deque>
#include <memory>

using namespace check;

namespace {

const std::string MAP = R"(<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
 <node id="1" lat="52.5000" lon="13.4000"/>
 <node id="2" lat="52.5010" lon="13.4010"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
</osm>
)";

// One answer: a status with no body, a body, compressed or not, or nothing at all for three seconds.
struct Step {
    int status = 200;
    std::string body = MAP;
    bool gzip = false;
    bool silent = false;
};
Step status(int code) { return {code, "", false, false}; }
Step body(std::string text) { return {200, std::move(text), false, false}; }

// An Overpass that answers with `script` in order, then with the map.
struct Overpass {
    Upstream upstream;
    std::mutex lock;
    std::deque<Step> script;
    int seen = 0;
    std::string accepted;
    explicit Overpass(std::vector<Step> steps = {}) : script(steps.begin(), steps.end()) {
        upstream.http.Post(".*", [this](const httplib::Request& req, httplib::Response& res) {
            Step step;
            {
                std::lock_guard guard(lock);
                ++seen;
                if (!script.empty()) {
                    step = script.front();
                    script.pop_front();
                }
                accepted = req.get_header_value("Accept-Encoding");
            }
            if (step.silent) {
                delay(3);
                return;
            }
            res.status = step.status;
            if (step.gzip) {
                res.set_header("Content-Encoding", "gzip");
                res.set_content(dstns::fabric::gzip(step.body, 6), "application/octet-stream");
            } else if (!step.body.empty()) {
                res.set_content(step.body, "application/octet-stream");
            }
        });
        upstream.start();
    }
    std::string url() const { return upstream.url() + "/api/interpreter"; }
};

// A port with nothing listening, so a connection to it is refused.
std::string closed(const std::string& path = "/api/interpreter") { return "http://127.0.0.1:" + std::to_string(free_port()) + path; }

std::string port_of(const std::string& url) { return url.substr(17, url.find('/', 17) - 17); }

struct Case {
    TempDir tmp;
    fs::path out = tmp / "tile.osm.xml";
    Ran fetch(const std::vector<std::string>& endpoints, std::vector<std::string> extra = {}) const {
        std::vector<std::string> args{server_binary(), "--fetch-osm", "--bbox", "52.499,13.399,52.502,13.402", "--output", out.string(), "--retries", "0"};
        for (const auto& endpoint : endpoints) args.insert(args.end(), {"--endpoint", endpoint});
        args.insert(args.end(), extra.begin(), extra.end());
        return run(args, {}, 60, Capture::Errors);
    }
    json manifest() const { return json::parse(read(fs::path(out).replace_extension(".manifest.json"))); }
};

} // namespace

int main() {
    {   // Downloads, and records where from.
        Case c;
        Overpass overpass;
        const auto result = c.fetch({overpass.url()});
        EXPECT(result.code == 0, result.output);
        EXPECT(read(c.out) == MAP);
        EXPECT(c.manifest().at("endpoint") == overpass.url() && c.manifest().at("bytes") == MAP.size(), c.manifest());
        EXPECT(overpass.seen == 1);
        EXPECT(!fs::exists(c.out.string() + ".progress"), "nothing is left behind for the progress reader");
    }
    {   // Fails over when a mirror refuses connections.
        Case c;
        Overpass overpass;
        const auto result = c.fetch({closed(), overpass.url()});
        EXPECT(result.code == 0, result.output);
        EXPECT(read(c.out) == MAP && overpass.seen == 1 && c.manifest().at("endpoint") == overpass.url(), "the healthy mirror served the map");
    }
    {   // Fails over when a mirror sheds load.
        Case c;
        Overpass busy({status(429)}), overpass;
        const auto result = c.fetch({busy.url(), overpass.url()});
        EXPECT(result.code == 0 && overpass.seen == 1, result.output);
    }
    {   // Retries the same mirror before moving on.
        Case c;
        Overpass flaky({status(503), body(MAP)});
        const auto result = c.fetch({flaky.url()}, {"--retries", "1"});
        EXPECT(result.code == 0 && flaky.seen == 2, "the mirror was retried, not abandoned", result.output);
    }
    {   // Asks for compression, and stores the map itself.
        Case c;
        Overpass overpass({{200, MAP, true, false}});
        const auto result = c.fetch({overpass.url()});
        EXPECT(result.code == 0, result.output);
        EXPECT(overpass.accepted == "gzip", overpass.accepted);
        EXPECT(read(c.out) == MAP && c.manifest().at("bytes") == MAP.size());
    }
    {   // Moves on from a mirror that says nothing.
        Case c;
        Overpass silent({{200, "", false, true}}), overpass;
        const auto result = c.fetch({silent.url(), overpass.url()}, {"--quiet-seconds", "0.5"});
        EXPECT(result.code == 0 && overpass.seen == 1, result.output);
    }
    {   // Tries another mirror when one answers with an error.
        Case c;
        Overpass busy({body("<osm><remark>runtime error: Query timed out</remark></osm>")}), overpass;
        const auto result = c.fetch({busy.url(), overpass.url()});
        EXPECT(result.code == 0 && overpass.seen == 1, result.output);
        for (const auto& entry : fs::directory_iterator(c.tmp.path)) EXPECT(entry.path().extension() != ".part", entry.path().string());
    }
    {   // Reports every endpoint, in one line that says what to do, when the host is offline.
        Case c;
        const auto first = closed("/api"), second = closed("/api");
        const auto result = c.fetch({first, second});
        EXPECT(result.code == 1, result.output);
        const auto message = trim(result.output);
        EXPECT(!contains(message, "\n"), message);
        for (const auto& part : {std::string("no route to Overpass from this host"), port_of(first), port_of(second), std::string("DSTNS_OVERPASS_ENDPOINTS"), std::string("--osm-file")}) {
            EXPECT(contains(message, part), part, message);
        }
        EXPECT(!fs::exists(c.out));
    }
    {   // Tells a busy Overpass from an unreachable one.
        Case c;
        Overpass busy({status(429)});
        const auto result = c.fetch({busy.url()});
        EXPECT(result.code == 1 && contains(result.output, "every Overpass endpoint failed") && contains(result.output, "429") && !contains(result.output, "no route"), result.output);
    }
    {   // Reads its endpoints from the environment.
        Case c;
        Overpass overpass;
        const auto result = run({server_binary(), "--fetch-osm", "--bbox", "52.499,13.399,52.502,13.402", "--output", c.out.string()},
                                {{"DSTNS_OVERPASS_ENDPOINTS", closed("/api") + ", " + overpass.url()}}, 60, Capture::Errors);
        EXPECT(result.code == 0 && overpass.seen == 1, result.output);
    }
    {   // Refuses a response that is not a map, and an empty one.
        Case c;
        Overpass timed_out({body("<osm><remark>runtime error: Query timed out</remark></osm>")});
        auto result = c.fetch({timed_out.url()});
        EXPECT(result.code == 1 && contains(result.output, "Query timed out") && !fs::exists(c.out), result.output);
        Overpass empty({body("<osm version=\"0.6\"></osm>")});
        result = c.fetch({empty.url()});
        EXPECT(result.code == 1 && contains(result.output, "no roads found") && !fs::exists(c.out), result.output);
    }
    std::cout << "fetch-osm ok: download, failover, retries, compression, silence, errors, offline and environment\n";
}
