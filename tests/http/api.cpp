// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The API end to end, against a real server: health, a run from start to stop, every view, every control, seeking and
// stepping, a new world, compression, news, logs, paging, the SUMO export, and a graceful exit.
#include "harness.hpp"
#include "support.hpp"

#include <set>

using namespace check;

int main() {
    TempDir logs("dstns-api-test-");
    Server server(logs.path, {"--map-cache", "keep"});
    int assertions = 0;
    const auto call = [&](const std::string& route, const std::string& method = "GET", std::optional<json> data = none) {
        ++assertions;
        return server.op(method, route, data, 5);
    };
    const auto lifecycle = [&] { return call("/api/v1/playback/status").data().at("lifecycle").get<std::string>(); };
    const auto prepared = [&] {
        return *until([&]() -> std::optional<json> {
            const auto status = call("/api/v1/playback/status");
            EXPECT(status.status == 200, status);
            if (status.data().at("lifecycle") == "PREPARING") return std::nullopt;
            return status.body;
        }, 10, "the world to be prepared");
    };

    // Health.
    auto reply = call("/health");
    EXPECT(reply.status == 200 && reply.body.at("ok") == true && contains(reply.body.at("product").get<std::string>(), "Deterministic"), reply);
    EXPECT(call("/api/v1/system/health").body.at("ok") == true);
    EXPECT(lifecycle() == "IDLE");

    // No map before a run. The seed selects a real city district that is downloaded on demand, so the server must not
    // compile a scenario (and must not reach the network) merely because it started.
    reply = call("/api/v1/view/topology");
    EXPECT(reply.status == 200 && (reply.data().is_null() || reply.data().empty()), reply);

    // Invalid requests are refused, with a code.
    reply = call("/api/v1/playback/start", "POST", json{{"tick_rate", -1}});
    EXPECT(reply.status == 400 && reply.code() == "INVALID_REQUEST", reply);
    reply = call("/api/v1/control/transit/route", "POST", json{{"bus_id", "MISSING-NODES"}});
    EXPECT(reply.status == 410 && reply.code() == "TRANSIT_API_RETIRED" && contains(reply.body.at("error").at("message").get<std::string>(), "no longer supported"), reply);
    reply = call("/api/v1/control/events/weather", "POST", json{{"epicenter_node", "not-a-number"}});
    EXPECT(reply.status == 400 && reply.code() == "INVALID_FIELD_TYPE" && contains(reply.body.at("error").at("message").get<std::string>(), "number"), reply);

    // The launcher waits for the observer before asking for a world.
    EXPECT(call("/api/v1/system/observer").data().at("loaded") == false);
    call("/");
    const auto observer = call("/api/v1/system/observer").data();
    EXPECT(observer.at("loaded") == true && observer.at("loads") >= 1, observer);

    // The seed is a number, in whichever form it is given.
    json start = {{"seed", "1311768467294899695"}, {"playback_duration_seconds", 3600}, {"day", 0}, {"map", {{"osm_file", "tests/fixtures/roads.osm.xml"}, {"max_nodes", 50}}}};
    reply = call("/api/v1/playback/start", "POST", start);
    EXPECT(reply.status == 202 && reply.data().at("lifecycle") == "PREPARING", reply);
    const auto seeded = prepared();
    EXPECT(seeded.at("seed") == "1311768467294899695", seeded);
    // 0x1234567890abcdef is the same number written in hexadecimal.
    EXPECT(seeded.at("global_seed") == "0x00000000000000001234567890abcdef", seeded);
    // Idle again, so that the run below starts from nothing.
    call("/api/v1/playback/stop", "POST", json::object());
    call("/api/v1/playback/reset", "POST", json::object());

    // A run, with every module.
    const json run_request = {{"seed", "0x123456789ABCDEF0"}, {"playback_duration_seconds", 3600}, {"day", 0}, {"map", {{"osm_file", "tests/fixtures/roads.osm.xml"}, {"max_nodes", 50}}},
                              {"tick_rate", 1.0}, {"modules", {{"traffic", true}, {"signals", true}, {"buildings", true}, {"dws", true}, {"flooding", true}, {"news", true}}},
                              {"dws", {{"frequency", 4}}}};
    reply = call("/api/v1/playback/start", "POST", run_request);
    EXPECT(reply.status == 202 && reply.data().at("lifecycle") == "PREPARING", reply);
    EXPECT(prepared().at("data").at("lifecycle") == "RUNNING");

    // The map now exists, is spread out, and reports both the metre projection and the place it was cut from.
    auto topo = call("/api/v1/view/topology").data();
    std::set<double> lons, lats;
    for (const auto& n : topo.at("nodes")) {
        lons.insert(n.at("position").at("lon").get<double>());
        lats.insert(n.at("position").at("lat").get<double>());
    }
    EXPECT(topo.at("nodes").size() >= 9 && lons.size() > 2 && lats.size() > 2, topo.at("nodes").size());
    EXPECT(topo.at("projection").at("units") == "metres" && topo.contains("location"));

    // A second start is a conflict.
    reply = call("/api/v1/playback/start", "POST", run_request);
    EXPECT(reply.status == 409 && reply.code() == "LIFECYCLE_CONFLICT", reply);

    // Pausing and seeking, with checkpoints along the way.
    reply = call("/api/v1/playback/pause", "POST", json::object());
    EXPECT(reply.status == 200 && reply.body.at("lifecycle") == "PAUSED", reply);
    EXPECT(call("/api/v1/playback/seek", "POST", json{{"target_time", "00:02:17"}}).status == 200);
    EXPECT(call("/api/v1/playback/seek", "POST", json{{"target_time", "00:50:01"}}).status == 200);
    EXPECT(call("/api/v1/playback/status").data().at("checkpoint_count") == 4);

    // The map's views.
    topo = call("/api/v1/view/topology").data();
    EXPECT(!topo.at("nodes").empty() && !topo.at("edges").empty() && topo.at("bounds").contains("min_lat"));
    // Place markers carry their canonical demand type, or null.
    for (const auto& f : topo.at("features")) {
        EXPECT(f.contains("demand_type"), f);
        const auto& type = f.at("demand_type");
        EXPECT(type.is_null() || type == "school" || type == "office" || type == "mall" || type == "store", type);
    }
    EXPECT(call("/api/v1/view/network").data().at("graph_hash") == topo.at("graph_hash"));
    EXPECT(call("/api/v1/view/map/full").data().at("topology_revision") == 1);

    // The changing state.
    const auto snap = call("/api/v1/view/snapshot").data();
    EXPECT(snap.at("nodes").size() == topo.at("nodes").size() && snap.contains("active_weather") && snap.contains("event_stack") && snap.contains("active_incidents"));

    // Everything at once.
    reply = call("/api/v1/view/global");
    EXPECT(reply.body.at("ok") == true);
    const auto d = reply.data();
    EXPECT(d.at("metrics").at("total_nodes") == topo.at("nodes").size() && d.at("metrics").at("total_edges") == topo.at("edges").size());
    EXPECT(d.at("bounds").contains("center_lat") && d.at("nodes").size() == topo.at("nodes").size() && d.at("edges").size() == topo.at("edges").size());
    for (const char* field : {"id", "osm_node_id", "position", "degree", "flood_susceptibility", "drainage", "roles", "dynamic"}) EXPECT(d.at("nodes")[0].contains(field), field);
    const auto e0 = d.at("edges")[0];
    for (const char* field : {"id", "from", "to", "reverse_twin", "road_class", "lanes", "length_m", "free_speed_mps", "geometry", "dynamic"}) EXPECT(e0.contains(field), field);
    for (const char* field : {"demand_vph", "effective_capacity_vph", "effective_speed_mps", "vehicle_count", "congestion", "flood", "closed"}) EXPECT(e0.at("dynamic").contains(field), field);
    EXPECT(call("/api/v1/view/world").body.at("ok") == true);

    // A one-way street's synthetic reverse carries nothing; transit routes are retired either way.
    json synthetic;
    for (const auto& edge : d.at("edges")) {
        if (!edge.at("synthetic_reverse").get<bool>()) continue;
        const bool real_twin = std::any_of(d.at("edges").begin(), d.at("edges").end(), [&](const json& c) {
            return c.at("from") == edge.at("from") && c.at("to") == edge.at("to") && !c.at("synthetic_reverse").get<bool>();
        });
        if (!real_twin) {
            synthetic = edge;
            break;
        }
    }
    EXPECT(!synthetic.is_null(), "a one-way street");
    reply = call("/api/v1/control/transit/route", "POST", json{{"bus_id", "ONEWAY-REVERSE"}, {"nodes", {synthetic.at("from"), synthetic.at("to")}}});
    EXPECT(reply.status == 410 && reply.body.at("ok") == false);
    EXPECT(synthetic.at("dynamic").at("effective_capacity_vph") == 0.0 && synthetic.at("dynamic").at("effective_speed_mps") == 0.0);
    const auto twin = d.at("edges")[synthetic.at("reverse_twin").get<std::size_t>()];
    reply = call("/api/v1/control/transit/route", "POST", json{{"bus_id", "ONEWAY-FORWARD"}, {"nodes", {twin.at("from"), twin.at("to")}}});
    EXPECT(reply.status == 410 && reply.code() == "TRANSIT_API_RETIRED");

    // Nodes and edges, paged and one at a time.
    EXPECT(call("/api/v1/view/nodes?offset=0&limit=10").data().at("items").size() <= 10);
    EXPECT(call("/api/v1/view/nodes/0").data().at("items")[0].at("id") == 0);
    EXPECT(call("/api/v1/view/edges?offset=0&limit=10").data().at("items").size() <= 10);
    EXPECT(call("/api/v1/view/edges/0").data().at("items")[0].at("id") == 0);

    // The catalogues.
    for (const char* catalogue : {"traffic", "weather", "buildings", "bus-stops", "signals", "events", "metrics", "incidents"}) {
        reply = call(std::string("/api/v1/view/") + catalogue);
        EXPECT(reply.status == 200 && (reply.data().contains("items") || reply.data().contains("vehicle_count")), catalogue, reply);
    }
    EXPECT(call("/api/v1/view/incidents").data().at("items").size() >= 4, "at least four incidents");
    const auto manifest = call("/api/v1/view/manifest").data();
    EXPECT(manifest.at("product") == "DSTNS" && !manifest.at("scenario_hash").get<std::string>().empty());

    // The tick rate, within its range.
    reply = call("/api/v1/control/tick-rate", "PUT", json{{"tick_rate", 0.5}});
    EXPECT(reply.status == 200 && reply.body.at("tick_rate") == 0.5 && reply.body.at("target_virtual_rate") == 86400.0 / 3600 * 0.5, reply);
    EXPECT(call("/api/v1/control/tick-rate", "PUT", json{{"tick_rate", 0.0}}).status == 400);
    EXPECT(call("/api/v1/control/tick-rate", "PUT", json{{"tick_rate", 150.0}}).status == 400);
    EXPECT(call("/api/v1/control/tick-rate", "PUT", json{{"tick_rate", 10.0}}).body.at("requested_tick_rate") == 10.0, "10x is the highest offered rate");
    EXPECT(call("/api/v1/control/tick-rate", "PUT", json{{"tick_rate", 10.5}}).status == 400, "rates above 10x are refused");
    EXPECT(call("/api/v1/control/tick-rate", "PUT", json{{"tick_rate", 0.5}}).status == 200);

    // The day.
    EXPECT(call("/api/v1/control/day", "POST", json{{"day", 1}}).body.at("day") == 1);
    EXPECT(call("/api/v1/control/day", "POST", json{{"day", 5}}).status == 400);

    // Every module off and on again.
    for (const char* module : {"dws", "traffic", "signals", "buildings", "flooding", "news"}) {
        const auto route = std::string("/api/v1/control/modules/") + module;
        EXPECT(call(route, "PUT", json{{"enabled", false}}).body.at("enabled") == false, module);
        EXPECT(call(route, "PUT", json{{"enabled", true}}).body.at("enabled") == true, module);
    }

    // Weather, a road changed, undone and redone.
    reply = call("/api/v1/control/events/weather", "POST", json{{"epicenter_node", 0}, {"intensity", 0.8}, {"radius_m", 700.0}, {"duration_virtual_minutes", 30}, {"flood_gain", 0.6}});
    EXPECT(reply.status == 202 && reply.body.at("status") == "scheduled", reply);
    reply = call("/api/v1/control/edges/0", "PUT", json{{"speed_multiplier", 0.5}, {"capacity_multiplier", 0.5}, {"closed", false}});
    EXPECT(reply.status == 200 && reply.body.at("edge_id") == 0, reply);
    EXPECT(call("/api/v1/control/undo", "POST", json{{"count", 1}}).body.at("undone").size() == 1);
    EXPECT(call("/api/v1/control/redo", "POST", json{{"count", 1}}).body.at("redone").size() == 1);
    EXPECT(!call("/api/v1/control/history").data().at("commands").empty());

    // Seeking, and stepping in exact increments that always leave the run paused.
    reply = call("/api/v1/playback/seek", "POST", json{{"target_time", "15:30:00"}});
    EXPECT(reply.body.at("simulated_seconds") == 55800 && reply.body.at("lifecycle") == "PAUSED", reply);
    reply = call("/api/v1/playback/step", "POST", json{{"seconds", 60}});
    EXPECT(reply.body.at("simulated_seconds") == 55860 && reply.body.at("lifecycle") == "PAUSED" && reply.body.at("stepped_seconds") == 60, reply);
    EXPECT(call("/api/v1/playback/step", "POST", json::object()).body.at("simulated_seconds") == 55920, "the default step is one minute");
    for (int bad : {0, -5, 3601}) {
        reply = call("/api/v1/playback/step", "POST", json{{"seconds", bad}});
        EXPECT(reply.status == 400 && reply.code() == "INVALID_REQUEST", bad, reply);
    }

    // A new world: a fresh seed, the operator's configuration, started paused, reported through a job to poll.
    const auto before = call("/api/v1/playback/status").body;
    EXPECT(call("/api/v1/world/status").data().at("enabled") == true);
    reply = call("/api/v1/world/regenerate", "POST", json{{"expected_run_id", "run_elsewhere"}});
    EXPECT(reply.status == 409 && reply.code() == "LIFECYCLE_CONFLICT", reply);
    reply = call("/api/v1/world/regenerate", "POST", json{{"expected_run_id", before.at("run_id")}});
    EXPECT(reply.status == 202 && !reply.data().at("seed").get<std::string>().empty() && reply.data().at("seed") != before.at("seed"), reply);
    const auto job = *until([&]() -> std::optional<json> {
        auto status = call("/api/v1/world/status").data();
        if (status.at("state") == "generating") return std::nullopt;
        return status;
    }, 30, "the new world");
    EXPECT(job.at("state") == "ready" && job.at("error").is_null(), job);
    const auto after = call("/api/v1/playback/status").body;
    EXPECT(after.at("run_id") == job.at("run_id") && after.at("run_id") != before.at("run_id") && after.at("seed") == job.at("seed") && after.at("global_seed") == job.at("seed_hex"), after);
    // A generated seed is a plain number an operator can read and retype.
    const auto seed = after.at("seed").get<std::string>();
    EXPECT(!seed.empty() && seed.size() <= 20 && std::all_of(seed.begin(), seed.end(), ::isdigit), seed);
    EXPECT(after.at("data").at("lifecycle") == "PAUSED" && after.at("clock").at("virtual_day_seconds") == 0, after);
    reply = call("/api/v1/view/topology");
    EXPECT(reply.body.at("run_id") == job.at("run_id") && !reply.data().at("edges").empty());
    // Later sections expect a run positioned mid-day.
    EXPECT(call("/api/v1/playback/seek", "POST", json{{"target_time", "15:30:00"}}).body.at("lifecycle") == "PAUSED");

    // Large JSON is compressed for a client that accepts it.
    reply = request(server.port, "GET", "/api/v1/view/topology", none, {{"Accept-Encoding", "gzip"}});
    EXPECT(reply.header("Content-Encoding") == "gzip", reply.header("Content-Encoding"));
    auto body = json::parse(reply.text, nullptr, false);
    if (body.is_discarded()) body = json::parse(dstns::fabric::gunzip(reply.text), nullptr, false);
    EXPECT(!body.is_discarded() && body.at("ok") == true);

    // News and logs.
    EXPECT(!call("/api/v1/news").data().at("items").empty());
    EXPECT(!call("/api/v1/view/logs/system").data().at("lines").empty());
    EXPECT(!call("/api/v1/view/logs/events").data().at("items").empty());
    EXPECT(!call("/api/v1/view/logs/api").data().at("items").empty());

    // Stopping and resetting.
    call("/api/v1/playback/play", "POST", json::object());
    EXPECT(call("/api/v1/playback/stop", "POST", json::object()).body.at("lifecycle") == "STOPPED");
    EXPECT(call("/api/v1/playback/reset", "POST", json::object()).body.at("lifecycle") == "IDLE");

    // Paging takes only whole unsigned numbers.
    for (const char* route : {"/api/v1/view/places", "/api/v1/view/stops", "/api/v1/view/nodes", "/api/v1/view/edges"}) {
        for (const char* query : {"offset=-1", "offset=1junk", "limit=0", "limit=nan", "offset=999999999999999999999999999"}) {
            EXPECT(call(std::string(route) + "?" + query).status == 400, route, query);
        }
    }
    EXPECT(call("/api/v1/view/place-kinds").data().at("items").size() == 18);
    const auto places = call("/api/v1/view/places?kind=bus_stop&limit=2001").data();
    EXPECT(places.at("limit") == 2000, places);
    EXPECT(call("/api/v1/view/stops?limit=2000").data().at("items") == places.at("items"));
    std::set<std::pair<std::string, std::string>> routes;
    for (const auto& group : json(call("/api/v1/system/endpoints").body.at("groups"))) {
        for (const auto& e : group.at("endpoints")) routes.insert({e.at("method").get<std::string>(), e.at("path").get<std::string>()});
    }
    EXPECT(routes.contains({"GET", "/api/v1/world/status"}) && routes.contains({"PUT", "/api/v1/control/edges/{id}/override"}));
    const auto info = call("/api/v1/system/info").body;
    EXPECT(contains(info.at("product").get<std::string>(), "Deterministic") && info.contains("sumo"), info);

    // SUMO: the export always, and a simulation where SUMO is installed.
    EXPECT(call("/api/v1/playback/start", "POST", run_request).status == 202);
    prepared();
    reply = call("/api/v1/export/sumo", "POST", json{{"directory", (logs / "sumo_exp").string()}});
    EXPECT(reply.status == 200 && reply.data().at("ok") == true, reply);
    EXPECT(fs::exists(logs / "sumo_exp" / "network.nod.xml"));
    if (info.at("sumo").at("available") == true) {
        reply = call("/api/v1/system/sumo-simulate", "POST", json{{"directory", (logs / "sumo_sim").string()}, {"begin_s", 0}, {"end_s", 1800}});
        EXPECT(reply.status == 200 && reply.data().at("ok") == true && reply.data().at("engine") == "SUMO", reply);
    }

    // A graceful exit, and the journal it leaves.
    EXPECT(call("/api/v1/system/terminate", "POST", json::object()).status == 200);
    EXPECT(server.process.wait(5) == 0, server.process.status);
    EXPECT(fs::exists(logs / "runtime.db") && fs::file_size(logs / "runtime.db") > 0);
    std::cout << "DSTNS API: " << assertions << " requests checked\n";
}
