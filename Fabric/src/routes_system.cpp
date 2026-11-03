// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/build_info.hpp"
#include "dstns/osm_fetch.hpp"
#include "dstns/sumo_bridge.hpp"
#include "support.hpp"
#include "dstns/next_world.hpp"
#include "dstns/webfabric/registry.hpp"

#include <sys/resource.h>
#include <unistd.h>

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
        send(r, {{"api_version", kApiVersion}, {"data", {{"loaded", loads > 0}, {"loads", loads}}}});
    });

    // An open observer says whether it is still showing its start-up. While it is, a world that
    // finishes waits for it. Saying nothing for a few seconds counts as having gone.
    server_->Post("/api/v1/system/observer", [this](const auto& req, auto& r) {
        const auto j = body(req);
        send(r, {{"api_version", kApiVersion}, {"data", engine_.observer_presence(j.value("waiting", false))}});
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
    // When this server started, for its uptime.
    static const auto started = std::chrono::steady_clock::now();
    server_->Get("/api/v1/system/info", [this](const auto&, auto& r) {
        auto env = SumoBridge::detect();
        rusage usage{};
        ::getrusage(RUSAGE_SELF, &usage);
#if defined(__APPLE__)
        const auto peak = static_cast<std::uint64_t>(usage.ru_maxrss);
#else
        const auto peak = static_cast<std::uint64_t>(usage.ru_maxrss) * 1024;
#endif
        send(r, {
            // The process itself: what a supervisor or the launcher's console shows.
            {"process", {{"pid", ::getpid()},
                         {"uptime_s", std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count()},
                         {"peak_rss_bytes", peak},
                         {"cpu_s", usage.ru_utime.tv_sec + usage.ru_stime.tv_sec + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6}}},
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
                {{"GET","/health","Liveness, for probes and load balancers"}},
                {{"GET","/api/v1","This index, at the API's root"}},
                {{"GET","/api/v1/system/health","Liveness, with the engine's lifecycle state"}},
                {{"GET","/api/v1/system/info","Service identity, version, the process (pid, uptime, memory) and SUMO availability"}},
                {{"GET","/api/v1/system/status","The full run status"}},
                {{"GET","/api/v1/system/endpoints","This index"}},
                {{"GET","/api/v1/system/map-status","What map is loaded and where it came from"}},
                {{"GET","/api/v1/system/source","Source offer under AGPL-3.0 section 13"}},
                {{"GET","/api/v1/system/backpressure","Adaptive backpressure score and mode"}},
                {{"POST","/api/v1/system/backpressure","Report observer health"}},
                {{"GET","/api/v1/system/ui-config","Operator defaults for the interface"}},
                {{"GET","/api/v1/system/observer","Observer page-load count"}},
                {{"POST","/api/v1/system/observer","An open observer reports whether a world should wait for it"}},
                {{"GET","/api/v1/system/narrator","Narration model, queue and cache"}},
                {{"GET","/api/v1/system/features","What the operator has turned on and off, and how the observer presents itself"}},
                {{"POST","/api/v1/system/terminate","Stop the simulation and exit the process"}},
                {{"POST","/api/v1/system/sumo-simulate","Export, build and run SUMO, and return trip statistics"}}}),
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
                {{"GET","/api/v1/view/nodes/{id}","One junction"}},
                {{"GET","/api/v1/view/edges/{id}","One road"}},
                {{"GET","/api/v1/view/run","The run: seed, configuration and clock"}},
                {{"GET","/api/v1/view/config","The run's resolved configuration"}},
                {{"GET","/api/v1/view/manifest","What makes this run reproducible: seed, map and build"}},
                {{"GET","/api/v1/view/traffic","Network totals: vehicles, speeds, closures and storms"}},
                {{"GET","/api/v1/view/congestion","The congestion index, now and on average"}},
                {{"GET","/api/v1/view/signals","Every signal's phase and timing"}},
                {{"GET","/api/v1/view/weather","Rain and flooding"}},
                {{"GET","/api/v1/view/incidents","Incidents in effect"}},
                {{"GET","/api/v1/view/bus-stops","Bus stops"}},
                {{"GET","/api/v1/view/buildings","Buildings and their effect on demand"}},
                {{"GET","/api/v1/view/metrics","Engine metrics: tick timing and rates"}},
                {{"GET","/api/v1/view/events","Events in effect now"}},
                {{"GET","/api/v1/view/stream","The snapshot, as server-sent events"}},
                {{"GET","/api/v1/places","Classified places"}},
                {{"POST","/api/v1/world/regenerate","Build a new world from a seed; {\"stage\": true} prepares it without replacing this one yet"}},
                {{"POST","/api/v1/world/regenerate/commit","Put in the world prepared with stage, now or as soon as it is ready"}},
                {{"POST","/api/v1/world/regenerate/discard","Forget the world prepared with stage"}},
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
                {{"GET","/api/v1/control/history","The control history"}},
                {{"POST","/api/v1/control/signals/{id}","Toggle a junction between north-south and east-west green"}},
                {{"POST","/api/v1/export/sumo","Write a SUMO bundle for the current world"}}}),
            group("observation","Logs, events and news",{
                {{"GET","/api/v1/view/event-queue","Scheduled or executed events, filtered and paged"}},
                {{"GET","/api/v1/news","The operator news feed"}},
                {{"GET","/api/v1/news/stream","The same feed, as server-sent events"}},
                {{"GET","/api/v1/view/logs/system","System log"}},
                {{"GET","/api/v1/view/logs/events","Event log"}},
                {{"GET","/api/v1/view/logs/api","API access log"}}}),
            group("fabric","Applications that register themselves with this server",{
                {{"GET","/api/v1/fabric/apps","Registered applications"}},
                {{"POST","/api/v1/fabric/apps","Register an application from its manifest"}},
                {{"GET","/api/v1/fabric/apps/{id}","One application"}},
                {{"DELETE","/api/v1/fabric/apps/{id}","Unregister"}},
                {{"POST","/api/v1/fabric/apps/{id}/heartbeat","Renew the application's lease"}},
                {{"PUT","/api/v1/fabric/apps/{id}/state","Report initialized, active or failed"}},
                {{"PUT","/api/v1/fabric/apps/{id}/ui","Declare the application's UI"}},
                {{"PUT","/api/v1/fabric/apps/{id}/ui/{element}","Update one element"}},
                {{"POST","/api/v1/fabric/apps/{id}/notifications","Send a notification"}},
                {{"GET","/api/v1/fabric/apps/{id}/events","Interactions, settings changes and lifecycle events"}},
                {{"GET","/api/v1/fabric/apps/{id}/settings","The application's settings"}},
                {{"PUT","/api/v1/fabric/apps/{id}/settings","Change settings"}},
                {{"PUT","/api/v1/fabric/apps/{id}/grants","Grant or revoke capabilities"}},
                {{"POST","/api/v1/fabric/apps/{id}/control","Act on the simulation, by capability"}},
                {{"PUT","/api/v1/fabric/apps/{id}/stops","Set the application's bus stops, and read their demand"}},
                {{"GET","/api/v1/fabric/apps/{id}/stops","Live demand at the application's bus stops"}},
                {{"POST","/api/v1/fabric/apps/{id}/ui/batch","Change several elements at once, all or none"}},
                {{"PUT","/api/v1/fabric/apps/{id}/subscriptions","Choose what of the simulation arrives as events"}},
                {{"GET","/api/v1/fabric/apps/{id}/timers","Timers on the simulation's clock"}},
                {{"PUT","/api/v1/fabric/apps/{id}/timers/{timer}","Set a timer on the simulation's clock"}},
                {{"DELETE","/api/v1/fabric/apps/{id}/timers/{timer}","Clear a timer"}},
                {{"GET","/api/v1/fabric/apps/{id}/storage","The application's stored keys"}},
                {{"GET","/api/v1/fabric/apps/{id}/storage/{key}","Read a stored value"}},
                {{"PUT","/api/v1/fabric/apps/{id}/storage/{key}","Store a value, kept across restarts"}},
                {{"DELETE","/api/v1/fabric/apps/{id}/storage/{key}","Delete a stored value"}},
                {{"POST","/api/v1/fabric/apps/{id}/messages","Send another application a message"}},
                {{"GET","/api/v1/fabric/apps/{id}/health","How the application is doing"}},
                {{"GET","/api/v1/fabric/capabilities","What this server offers applications"}},
                {{"GET","/api/v1/fabric/engine/status","Lifecycle and clock"}},
                {{"POST","/api/v1/fabric/engine/{start|prepare|play|pause|stop|reset|seek|step}","Move through simulated time"}},
                {{"PUT","/api/v1/fabric/engine/tick-rate","Set the speed"}},
                {{"POST","/api/v1/fabric/engine/{day|undo|redo}","Change the day; undo and redo control actions"}},
                {{"GET","/api/v1/fabric/engine/history","Recent control actions"}},
                {{"POST","/api/v1/fabric/engine/events/{weather|traffic|surge}","Schedule an event"}},
                {{"PUT","/api/v1/fabric/engine/edges/{id}","Override a road"}},
                {{"POST","/api/v1/fabric/engine/signals/{id}","Toggle a signal"}},
                {{"PUT","/api/v1/fabric/engine/modules/{module}","Turn a subsystem on or off"}},
                {{"POST","/api/v1/fabric/apps/{id}/credentials/rotate","Replace the application's token and signing key"}},
                {{"PUT","/api/v1/fabric/apps/{id}/launch","Propose how the launcher should start this application"}},
                {{"GET","/api/v1/fabric/launch","Launch proposals waiting for a person"}},
                {{"POST","/api/v1/fabric/apps/{id}/reload","End the application's link, so that it connects again anew"}},
                {{"PUT","/api/v1/fabric/launch/{id}/key","The launcher's one-time key for an application it is starting"}},
                {{"PUT","/api/v1/fabric/launch/{id}","Propose how the launcher should start an application"}},
                {{"PUT","/api/v1/fabric/launch/plan","What the launcher is starting, for the observer"}},
                {{"GET","/api/v1/fabric/security","What is protecting what"}},
                {{"GET","/api/v1/fabric/audit/verify","Check the audit log's hash chain"}},
                {{"GET","/api/v1/fabric/audit","Control actions taken by applications"}},
                {{"GET","/api/v1/fabric/state","Everything applications declare, for the observer"}},
                {{"DELETE","/api/v1/fabric/apps/{id}/ui/{element}","Remove one element"}},
                {{"DELETE","/api/v1/fabric/apps/{id}/settings","Reset settings to their defaults"}},
                {{"POST","/api/v1/fabric/apps/{id}/view","Ask the map to look somewhere"}},
                {{"POST","/api/v1/fabric/apps/{id}/view/outcome","Report what became of a request to move the map"}},
                {{"PUT","/api/v1/fabric/apps/{id}/presentation","Hold layers and places on or off"}},
                {{"DELETE","/api/v1/fabric/apps/{id}/presentation","Let go of held layers and places"}},
                {{"POST","/api/v1/fabric/apps/{id}/actions","Record what a person did"}},
                {{"POST","/api/v1/fabric/apps/{id}/suspend","Suspend the application"}},
                {{"POST","/api/v1/fabric/apps/{id}/resume","Resume the application"}},
                {{"POST","/api/v1/fabric/apps/{id}/failure","Report that the application's interface failed"}},
                {{"DELETE","/api/v1/fabric/launch/plan","The launcher has finished starting things"}},
                {{"DELETE","/api/v1/fabric/launch/{id}","Withdraw a proposal"}}}),
        });
    };
    server_->Get("/api/v1/system/endpoints", [index_of_api](const auto&, auto& r) {
        send(r, {{"ok",true},{"version","v1"},{"base","/api/v1"},{"groups",index_of_api()}});
    });
    server_->Get("/api/v1", [index_of_api](const auto&, auto& r) {
        send(r, {{"ok",true},{"version","v1"},{"base","/api/v1"},{"groups",index_of_api()}});
    });

    // SUMO Microscopic Export & Simulation
    // A tool that fails or a directory that can't be written is the environment's doing, and says so.
    const auto sumo_step = [](const auto& step) {
        try {
            step();
        } catch (const Refusal&) {
            throw;
        } catch (const std::runtime_error& e) {
            throw Refusal(503, "SUMO_FAILED", e.what());
        }
    };
    server_->Post("/api/v1/export/sumo", [this, sumo_step](const auto& req, auto& r) {
        auto j = body(req);
        const auto dir = output_directory(req, j, "data/sumo_export");
        sumo_step([&] { send(r, engine_.export_sumo(dir)); });
    });
    server_->Post("/api/v1/system/sumo-simulate", [this, sumo_step](const auto& req, auto& r) {
        auto j = body(req);
        const auto dir = output_directory(req, j, "data/sumo_run");
        const auto begin_s = time_value(j.value("begin_s", json(0)));
        const auto end_s = time_value(j.value("end_s", json(3600)));
        sumo_step([&] { send(r, engine_.sumo_simulate(dir, begin_s, end_s)); });
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
        send(r, {{"api_version", kApiVersion},
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
        send(r, {{"api_version", kApiVersion},
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
                send(r, {{"api_version", kApiVersion}, {"data", parsed}});
                return;
            } catch (const json::parse_error& e) {
                // A malformed file must not take the interface down; the client
                // falls back to its built-in defaults and the operator is told.
                send(r, {{"api_version", kApiVersion},
                         {"error", {{"code", "UI_CONFIG_INVALID"},
                                    {"message", std::string("config/ui-config.json is not valid JSON: ") + e.what()}}}},
                     500);
                return;
            }
        }
        send(r, {{"api_version", kApiVersion}, {"data", json::object()}});
    });

    // ASB. The observer reports how far behind it is; the response carries the
    // full backpressure state so one round trip both informs and instructs.
    server_->Post("/api/v1/system/backpressure", [this](const auto& req, auto& r) {
        auto j = body(req);
        send(r, engine_.report_backpressure(
                    j.value("virtual_lag_s", 0.0),
                    j.value("client_frame_s", 0.0),
                    j.value("since_poll_s", 0.0),
                    j.value("away", false)));
    });
    server_->Get("/api/v1/system/backpressure", [this](const auto&, auto& r) {
        send(r, engine_.backpressure());
    });

    // What the operator has turned on and off, and how the observer should present itself. Read-only, and set
    // only by whoever starts the server: see docs/reference/environment-variables.md.
    server_->Get("/api/v1/system/features", [](const auto&, auto& r) {
        const auto& on = switches();
        const char* regeneration = std::getenv("DSTNS_DISABLE_WORLD_REGENERATION");
        auto presentation = json{{"webfabric", true}, {"force_animate", true}, {"fast_boot", false}, {"dynamic_fastboot", true}, {"dynamic_particles", true},
                                 {"demo", false}, {"music", false}, {"fullscreen", false}, {"music_volume", 0.6}, {"map_fps", 0}, {"render_scale", 2.0}, {"film_particles", 32000}};
        presentation.update(on.presentation);
        // The engine's own switch decides whether it fetches ahead; the observer is told what it does.
        if (!NextWorld::enabled()) presentation["dynamic_fastboot"] = false;
        // Fast Boot exists to skip the wait, and the dynamic film plans its own length, so in either case the film is not
        // made to play to its end.
        if (presentation.value("fast_boot", false) || presentation.value("dynamic_particles", false)) presentation["force_animate"] = false;
        send(r, {{"api_version", kApiVersion}, {"data", {
            {"applications", on.applications}, {"legacy_api", on.legacy_api}, {"launch_proposals", on.launch_proposals},
            {"require_signatures", on.require_signatures}, {"disabled_capabilities", on.disabled},
            {"world_regeneration", !(regeneration && std::string(regeneration) == "1")}, {"presentation", presentation},
            {"performance", server_performance()}}}});
    });
    server_->Get("/api/v1/system/narrator", [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"data", engine_.narrator_status()}});
    });
}
} // namespace dstns
