// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/build_info.hpp"
#include "dstns/osm_fetch.hpp"
#include "dstns/sumo_bridge.hpp"
#include "support.hpp"

#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <thread>

namespace dstns {
using namespace fabric;

// Service identity, health, lifecycle, licence and backpressure.
void ApiServer::routes_system() {
    // Whether the observer has been loaded in a browser yet. The launcher
    // opens the interface first and waits for this before starting a run, so
    // world selection and the download are watched rather than hidden.
    server_->Get("/api/v1/system/observer", [this](const auto&, auto& r) {
        const auto loads = observer_loads_.load();
        send(r, {{"api_version", "1.0"}, {"data", {{"loaded", loads > 0}, {"loads", loads}}}});
    });

    // Health & System Status
    auto health_handler = [this](const auto&, auto& r) {
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"observer_ui_version", "observer-v2"},
            {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
            {"version", DSTNS_VERSION},
            {"lifecycle", to_string(engine_.lifecycle())}
        });
    };
    server_->Get("/health", health_handler);
    server_->Get("/api/v1/system/health", health_handler);
    server_->Get("/api/v1/system/status", [this](const auto&, auto& r) { send(r, engine_.status()); });
    server_->Get("/api/v1/system/info", [this](const auto&, auto& r) {
        auto env = SumoBridge::detect();
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
            {"version", DSTNS_VERSION},
            {"build", {{"compiler", __VERSION__}, {"cpp_standard", __cplusplus},
                       {"revision", DSTNS_REVISION}, {"created", DSTNS_BUILD_DATE},
                       {"channel", DSTNS_CHANNEL}, {"type", DSTNS_BUILD_TYPE},
                       {"architecture", DSTNS_BUILD_ARCH}}},
            {"lifecycle", to_string(engine_.lifecycle())},
            {"sumo", {
                {"available", env.available},
                {"version", env.sumo_version},
                {"sumo_binary", env.sumo_binary.string()},
                {"netconvert_binary", env.netconvert_binary.string()},
                {"sumo_home", env.sumo_home.string()}
            }}
        });
    });

    // An index of the API, served by the API. A client that has the base URL
    // can discover everything else from here rather than from a document that
    // may have drifted.
    auto index_of_api = [] {
        auto group = [](const char* name, const char* purpose, std::initializer_list<std::array<const char*,3>> routes) {
            auto items = nlohmann::json::array();
            for (const auto& [method, path, note] : routes)
                items.push_back({{"method",method},{"path",path},{"description",note}});
            return nlohmann::json{{"group",name},{"purpose",purpose},{"endpoints",std::move(items)}};
        };
        return nlohmann::json::array({
            group("system","Service identity, health and lifecycle",{
                {{"GET","/api/v1/system/health","Liveness, with the engine's lifecycle state"}},
                {{"GET","/api/v1/system/info","Service identity, version and SUMO availability"}},
                {{"GET","/api/v1/system/status","The full run status"}},
                {{"GET","/api/v1/system/endpoints","This index"}},
                {{"GET","/api/v1/system/map-status","What map is loaded and where it came from"}},
                {{"GET","/api/v1/system/source","Source offer under AGPL-3.0 section 13"}},
                {{"GET","/api/v1/system/backpressure","Adaptive backpressure score and mode"}},
                {{"POST","/api/v1/system/backpressure","Report observer health"}},
                {{"GET","/api/v1/system/ui-config","Operator defaults for the interface"}},
                {{"GET","/api/v1/system/observer","Observer page-load count"}},
                {{"GET","/api/v1/system/narrator","Narration model, queue and cache"}},
                {{"POST","/api/v1/system/terminate","Stop the simulation and exit the process"}}}),
            group("playback","Moving through simulated time",{
                {{"GET","/api/v1/playback/status","Clock, rate and lifecycle"}},
                {{"POST","/api/v1/playback/start","Begin a run"}},
                {{"POST","/api/v1/playback/prepare","Prepare without starting playback"}},
                {{"POST","/api/v1/playback/play","Resume"}},
                {{"POST","/api/v1/playback/pause","Hold the clock"}},
                {{"POST","/api/v1/playback/stop","End the run"}},
                {{"POST","/api/v1/playback/reset","Return to the start"}},
                {{"POST","/api/v1/playback/seek","Jump to a virtual second"}},
                {{"POST","/api/v1/playback/step","Advance a fixed number of ticks"}}}),
            group("world","The generated world and its topology",{
                {{"GET","/api/v1/view/topology","Nodes, edges, features, projection and bounds"}},
                {{"GET","/api/v1/view/nodes","Paginated nodes; /{id} for one"}},
                {{"GET","/api/v1/view/edges","Paginated edges; /{id} for one"}},
                {{"GET","/api/v1/view/places","Classified places with live demand; ?kind= filters"}},
                {{"GET","/api/v1/view/place-kinds","The place taxonomy and this world's counts"}},
                {{"GET","/api/v1/view/stops","Bus stops, thinned to realistic spacing"}},
                {{"GET","/api/v1/view/snapshot","Per-tick dynamic state for every node and edge"}},
                {{"GET","/api/v1/view/global","Topology and snapshot in one response"}},
                {{"POST","/api/v1/world/regenerate","Build a new world from a seed"}},
                {{"GET","/api/v1/world/status","Preparation progress and durable errors"}}}),
            group("control","Acting on the running simulation",{
                {{"PUT","/api/v1/control/tick-rate","Set the simulation rate multiplier"}},
                {{"POST","/api/v1/control/day","Switch between a weekday and a weekend"}},
                {{"PUT","/api/v1/control/modules/{module}","Enable or disable a subsystem"}},
                {{"POST","/api/v1/control/events/weather","Inject rain or a flood"}},
                {{"POST","/api/v1/control/events/traffic","Inject an incident or a closure"}},
                {{"POST","/api/v1/control/events/surge","Inject a demand surge"}},
                {{"PUT","/api/v1/control/edges/{id}/override","Override one edge"}},
                {{"POST","/api/v1/control/undo","Undo the last control action"}},
                {{"POST","/api/v1/control/redo","Redo it"}},
                {{"GET","/api/v1/control/history","The control history"}}}),
            group("observation","Logs, events and news",{
                {{"GET","/api/v1/view/event-queue","Scheduled or executed events, filtered and paged"}},
                {{"GET","/api/v1/news","The operator news feed"}},
                {{"GET","/api/v1/news/stream","The same feed, as server-sent events"}},
                {{"GET","/api/v1/view/logs/system","System log"}},
                {{"GET","/api/v1/view/logs/events","Event log"}},
                {{"GET","/api/v1/view/logs/api","API access log"}}}),
        });
    };
    server_->Get("/api/v1/system/endpoints", [index_of_api](const auto&, auto& r) {
        send(r, {{"ok",true},{"version","v1"},{"base","/api/v1"},{"groups",index_of_api()}});
    });
    server_->Get("/api/v1", [index_of_api](const auto&, auto& r) {
        send(r, {{"ok",true},{"version","v1"},{"base","/api/v1"},{"groups",index_of_api()}});
    });

    // SUMO Microscopic Export & Simulation
    server_->Post("/api/v1/export/sumo", [this](const auto& req, auto& r) {
        auto j = body(req);
        std::filesystem::path dir = j.value("directory", "data/sumo_export");
        send(r, engine_.export_sumo(dir));
    });
    server_->Post("/api/v1/system/sumo-simulate", [this](const auto& req, auto& r) {
        auto j = body(req);
        std::filesystem::path dir = j.value("directory", "data/sumo_run");
        const auto begin_s = time_value(j.value("begin_s", json(0)));
        const auto end_s = time_value(j.value("end_s", json(3600)));
        send(r, engine_.sumo_simulate(dir, begin_s, end_s));
    });

    auto terminate_handler = [this](const auto&, auto& r) {
        send(r, {
            {"ok", true},
            {"service", "dstns"},
            {"product", "Deterministic Spatiotemporal Transport Network Simulator"},
            {"status", "TERMINATING"},
            {"message", "DSTNS server is shutting down gracefully."}
        });
        // Terminating means quitting: the process goes away, not just the run.
        //
        // The request is made lock-free because a scenario compile can hold the
        // engine lock for the length of a map download, and an operator who has
        // asked to quit should not wait that out. The listener is then stopped
        // so main() can return normally, and a backstop guarantees the process
        // exits even if a long-running compile is still unwinding.
        engine_.request_terminate();
        logger_.system("INFO", "api", "Termination requested; shutting down");
        if (termination_started_.exchange(true)) return;
        shutdown_worker_ = std::thread([this]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(150));
            stop();
        });
        // No captured object: this fallback can outlive ApiServer safely. The
        // owned downloader group was already cancelled before starting it.
        std::thread([] {
            std::this_thread::sleep_for(std::chrono::seconds(3));
            std::fflush(nullptr);
            std::_Exit(0);
        }).detach();
    };
    // POST only: a GET that shuts the server down can be triggered by any
    // page the operator happens to open, through an image or a link.
    server_->Post("/terminate", terminate_handler);
    server_->Post("/api/v1/system/terminate", terminate_handler);

    // AGPL section 13: this program is offered over a network, so every user
    // interacting with it must be told where to obtain the corresponding
    // source of the version they are running.
    server_->Get("/api/v1/system/source", [](const auto&, auto& r) {
        send(r, {{"api_version", "1.0"},
                 {"data", {
                     {"program", "DSTNS"},
                     {"version", DSTNS_VERSION},
                     {"copyright", "Copyright (C) 2026 Varun Karthic"},
                     {"license", "AGPL-3.0-or-later"},
                     {"license_url", "https://www.gnu.org/licenses/agpl-3.0.html"},
                     {"source_offer",
                      "You may obtain the complete corresponding source for this running "
                      "version, under the terms of the GNU Affero General Public License "
                      "version 3 or later. The source accompanies this deployment; see the "
                      "LICENSE and COPYRIGHT files distributed with it."},
                     {"map_data", {
                         {"source", "OpenStreetMap contributors"},
                         {"license", "ODbL 1.0"},
                         {"url", "https://www.openstreetmap.org/copyright"}}}}}});
    });

    // Observability for a download in flight. Unauthenticated and read-only:
    // it reports only progress through a map the seed already determined.
    server_->Get("/api/v1/system/map-status", [this](const auto&, auto& r) {
        const auto status = current_map_fetch();
        send(r, {{"api_version", "1.0"},
                 {"data", {{"active", status.active},
                           // What a preparation is spending its time on, even
                           // while no map is being downloaded.
                           {"preparation", engine_.preparation_stage()},
                           {"city", status.city},
                           {"country", status.country},
                           {"phase", status.phase},
                           {"bytes", status.bytes},
                           {"total", status.total},
                           {"elapsed_s", status.elapsed_s}}}});
    });

    // Presentation defaults for the observer. Served rather than bundled so an
    // operator can change the interface's starting state without rebuilding the
    // front end. Nothing here reaches the simulation.
    server_->Get("/api/v1/system/ui-config", [](const auto&, auto& r) {
        for (const auto* candidate : {"config/ui-config.json", "../config/ui-config.json",
                                      "/app/config/ui-config.json"}) {
            std::ifstream in(candidate);
            if (!in) continue;
            try {
                json parsed;
                in >> parsed;
                send(r, {{"api_version", "1.0"}, {"data", parsed}});
                return;
            } catch (const json::parse_error& e) {
                // A malformed file must not take the interface down; the client
                // falls back to its built-in defaults and the operator is told.
                send(r, {{"api_version", "1.0"},
                         {"error", {{"code", "UI_CONFIG_INVALID"},
                                    {"message", std::string("config/ui-config.json is not valid JSON: ") + e.what()}}}},
                     500);
                return;
            }
        }
        send(r, {{"api_version", "1.0"}, {"data", json::object()}});
    });

    // ASB. The observer reports how far behind it is; the response carries the
    // full backpressure state so one round trip both informs and instructs.
    server_->Post("/api/v1/system/backpressure", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.report_backpressure(
                    j.value("virtual_lag_s", 0.0),
                    j.value("client_frame_s", 0.0),
                    j.value("since_poll_s", 0.0)));
    });
    server_->Get("/api/v1/system/backpressure", [this](const auto&, auto& r) {
        send(r, engine_.backpressure());
    });

    server_->Get("/api/v1/system/narrator", [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"data", engine_.narrator_status()}});
    });
}
} // namespace dstns
