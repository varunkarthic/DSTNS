// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The launcher starting real applications with a real engine: the engine comes up, the applications are started, and
// only once each says it is ready does the simulation start. A person reloads one and it comes back as itself. Then
// they stop with the launcher, and a required application that fails stops a run from starting, saying why.
//
// The applications are this program too, run as `launcher_apps --app <id> --name <name> --url <url> [--wait <s>]`:
// it registers, waits that long, says it is active, and keeps its lease until it is stopped.
#include "harness.hpp"

#include <fstream>

using namespace check;

namespace {

const std::string APP = "org.example.hello";
const std::string SLOW = "org.example.slow";
const std::string FIXTURE = "data/fixtures/real_network.osm.xml";

int as_application(int argc, char** argv) {
    std::map<std::string, std::string> options;
    for (int i = 1; i + 1 < argc; i += 2) options[argv[i]] = argv[i + 1];
    const auto url = options["--url"];
    const int port = std::stoi(url.substr(url.rfind(':') + 1));
    const auto base = "/api/v1/fabric/apps/" + options["--app"];
    Headers launch;
    if (!env("DSTNS_FABRIC_LAUNCH_KEY").empty()) launch["X-DSTNS-Launch-Key"] = env("DSTNS_FABRIC_LAUNCH_KEY");
    const auto made = request(port, "POST", "/api/v1/fabric/apps", json{{"id", options["--app"]}, {"name", options["--name"]}, {"version", "1.0.0"}}, launch, 10);
    if (made.status != 201) return 3;
    const Headers token = {{"Authorization", "Bearer " + made.data().at("token").get<std::string>()}};
    delay(options.contains("--wait") ? std::stod(options["--wait"]) : 0);
    request(port, "PUT", base + "/state", json{{"state", "active"}}, token, 10);
    while (true) {
        delay(1);
        request(port, "POST", base + "/heartbeat", json::object(), token, 10);
    }
}

} // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::string(argv[1]) == "--app") return as_application(argc, argv);
    const std::string self = fs::absolute(argv[0]).string();
    const int port = free_port();
    TempDir tmp;
    // Settings of the test's own, from the checkout's but with where worlds are and the engine at their defaults: the
    // settings of the machine running the test must not decide what it tests.
    const auto settings = tmp / "config";
    fs::create_directories(settings);
    for (const auto& entry : fs::directory_iterator(root() / "config"))
        if (entry.path().extension() == ".json") fs::copy_file(entry.path(), settings / entry.path().filename());
    {
        auto defaults = json::parse(read(settings / "defaults.json"));
        defaults.erase("engine");
        defaults["map"]["selection_mode"] = "global";
        defaults["map"]["places"] = "all";
        std::ofstream(settings / "defaults.json") << defaults.dump(2);
        auto engines = json::parse(read(settings / "engines.json"));
        engines["selected"] = "core-legacy";
        // What each engine is comes from the build; the launcher writes it back at every start.
        for (auto& [id, entry] : engines["engines"].items())
            for (const auto* key : {"channel", "version", "kind"}) entry.erase(key);
        std::ofstream(settings / "engines.json") << engines.dump(2);
    }
    const Env environment = {{"DSTNS_CONFIG_DIR", settings.string()}, {"DSTNS_API_PORT", std::to_string(port)}, {"DSTNS_LOGS_DIR", tmp.str()}, {"DSTNS_APPS_FILE", (tmp / "apps.json").string()},
                             {"DSTNS_SEED_DB", (tmp / "seeds.db").string()}, {"DSTNS_LAUNCHER_ENV", (tmp / "launcher.env").string()},
                             {"DSTNS_SETUP_COMPLETE", "1"}, {"DSTNS_BUILD_DIR", fs::path(server_binary()).parent_path().string()}, {"NO_COLOR", "1"}};
    const std::string launcher = (root() / "launcher").string();
    const auto launch = [&](std::vector<std::string> args, bool check = true) {
        args.insert(args.begin(), launcher);
        auto done = run(args, environment, 300);
        EXPECT(!check || done.code == 0, done.output);
        return done;
    };
    const auto get = [&](const std::string& route, const Headers& headers = {}) -> Reply {
        try {
            return request(port, "GET", route, none, headers, 5);
        } catch (const Unreachable&) {
            return {};
        }
    };
    const auto app_command = [&](const std::string& id, const std::string& name, const std::string& wait) {
        return self + " --app " + id + " --name " + name + " --url {url} --wait " + wait;
    };

    launch({"apps", "add", APP, "--command", app_command(APP, "Hello", "0"), "--name", "Hello", "--required", "--timeout", "30"});
    // One that takes a while, so that the wait can be seen: it reports ready only after three seconds.
    launch({"apps", "add", SLOW, "--command", app_command(SLOW, "Slow", "3"), "--name", "Slow", "--timeout", "30"});
    const auto listed = launch({"apps", "list"}).output;
    EXPECT(contains(listed, APP) && contains(listed, SLOW), listed);
    launch({"apps", "doctor"});

    std::string output;
    {
        auto started = Process::start({launcher, "start", "--no-open", "--osm-file", FIXTURE, "--seed", "10775", "--duration", "600", "--apps", APP + "," + SLOW},
                                      environment, Capture::Output);
        // The simulation must not have started while any application was not ready.
        std::optional<std::map<std::string, std::string>> at_start;
        bool seen_plan = false;
        Headers operator_header;
        for (const double end = now() + 120; now() < end && !at_start;) {
            if (operator_header.empty() && fs::exists(tmp / "operator.token")) operator_header = {{"X-DSTNS-Operator", trim(read(tmp / "operator.token"))}};
            const auto status = get("/api/v1/fabric/engine/status");
            std::map<std::string, std::string> states;
            if (!operator_header.empty()) {
                for (const auto& app : {APP, SLOW}) {
                    const auto health = get("/api/v1/fabric/apps/" + app + "/health", operator_header);
                    if (health.status == 200) states[app] = health.data().value("state", "");
                }
                const auto state = get("/api/v1/fabric/state?since=0");
                if (state.status == 200 && state.data().contains("launch_plan") && state.data()["launch_plan"].is_object()) {
                    seen_plan = seen_plan || !state.data()["launch_plan"].value("apps", json::array()).empty();
                }
            }
            if (status.status == 200 && status.data().value("lifecycle", "IDLE") != "IDLE") at_start = states;
            delay(0.05);
        }
        EXPECT(at_start, "the simulation never started", started.output());
        EXPECT(((*at_start)[APP] == "active" && (*at_start)[SLOW] == "active"), "it started with", json(*at_start));
        EXPECT(seen_plan, "the observer was told what was being started");
        {
            const auto engines = json::parse(read(settings / "engines.json")).at("engines");
            const auto info = get("/api/v1/system/info").body;
            EXPECT(engines.at("core-ng").value("channel", "") == "alpha" && engines.at("core-legacy").value("channel", "") == "stable", engines);
            EXPECT(engines.at("core-legacy").value("version", "") == info.value("version", "?") && engines.at("core-ng").value("kind", "") == "real", engines);
        }
        // The plan stays while they run, which is how a reloaded application comes back as itself.
        const auto running = get("/api/v1/fabric/state?since=0").data().at("launch_plan").at("apps");
        for (const auto& entry : running) EXPECT(entry.at("state") == "ready", running);

        // A person reloads one: its link ends, the launcher starts it again, and it comes back as itself.
        EXPECT(request(port, "POST", "/api/v1/fabric/apps/" + APP + "/reload", json::object(), operator_header, 5).data().at("managed") == true);
        until([&] {
            const auto health = get("/api/v1/fabric/apps/" + APP + "/health", operator_header);
            return health.status == 200 && health.data().value("state", "") == "active" && health.data().value("uptime_s", 99.0) < 30;
        }, 15, "it to come back after being reloaded");

        // The launcher can see them, and the application is really running under it.
        const auto status = launch({"apps", "status"}).output;
        EXPECT(contains(status, APP) && contains(status, "active"), status);
        EXPECT(contains(launch({"fabric", "status"}).output, "Intact"));

        started.signal_group(SIGTERM);
        EXPECT(started.wait(30) != -1, "the launcher stopped", started.output());
        output = started.finish();
    }
    EXPECT(contains(output, "Hello ready") && contains(output, "Slow ready") && contains(output, "Reloading Hello"), output);
    // They went with the launcher, whose server has stopped.
    until([&] { return get("/health").status == 0; }, 8, "the server to stop");
    EXPECT(run({"pgrep", "-f", "--", "--app " + SLOW}).code == 1, "the application stopped");

    // Failing to start a required one stops the run from starting, with the reason.
    launch({"apps", "add", "org.example.broken", "--command", "sh -c 'echo nothing here; exit 4'", "--required"});
    const auto broken = launch({"start", "--no-open", "--osm-file", FIXTURE, "--seed", "10775", "--apps", "org.example.broken"}, false);
    EXPECT(broken.code != 0, broken.output);
    EXPECT(contains(broken.output, "is required") && contains(broken.output, "status 4"), broken.output);
    std::cout << "launcher apps ok\n";
}
