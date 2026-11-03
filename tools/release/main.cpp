// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// dstns_release: what releasing DSTNS needs, apart from building it.
//
//     dstns_release metadata                     the image's version, revision, time and channel (GITHUB_OUTPUT too)
//     dstns_release publish --digests <dir>      put both platforms' images under one index, then the public tags
//     dstns_release smoke <image> --arch <a>     run a packaged image and check what it serves and says about itself
//     dstns_release headers --check | --fix      the licence header on every source file
//
// It runs `docker` and `git` as programs, never through a shell, and never writes to a registry except in publish.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

fs::path root() {
    if (const char* value = std::getenv("DSTNS_ROOT"); value && *value) return value;
    return DSTNS_SOURCE_DIR;
}

std::string env(const char* name) {
    const char* value = std::getenv(name);
    return value ? value : "";
}

std::string read(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(in), {}};
}

[[noreturn]] void stop(const std::string& why) {
    std::cerr << why << '\n';
    std::exit(1);
}

struct Ran {
    int code;
    std::string out;
};

// A program and its standard output; its errors go to ours.
Ran run(const std::vector<std::string>& argv) {
    int pipe_ends[2];
    if (::pipe(pipe_ends) != 0) stop("pipe failed");
    const pid_t pid = ::fork();
    if (pid == 0) {
        ::dup2(pipe_ends[1], 1);
        ::close(pipe_ends[0]);
        std::vector<char*> args;
        for (const auto& arg : argv) args.push_back(const_cast<char*>(arg.c_str()));
        args.push_back(nullptr);
        ::execvp(args[0], args.data());
        std::cerr << argv[0] << " could not be run\n";
        ::_exit(127);
    }
    ::close(pipe_ends[1]);
    std::string out;
    char buffer[4096];
    for (ssize_t got; (got = ::read(pipe_ends[0], buffer, sizeof buffer)) > 0;) out.append(buffer, static_cast<std::size_t>(got));
    ::close(pipe_ends[0]);
    int status = 0;
    ::waitpid(pid, &status, 0);
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
    return {WIFEXITED(status) ? WEXITSTATUS(status) : 128, out};
}

// As run, but a failure ends the release with what failed.
std::string must(const std::vector<std::string>& argv) {
    auto ran = run(argv);
    if (ran.code != 0) {
        std::string shown;
        for (const auto& arg : argv) shown += arg + " ";
        stop(shown + "failed with status " + std::to_string(ran.code));
    }
    return ran.out;
}

std::string version() {
    std::smatch found;
    const auto text = read(root() / "CMakeLists.txt");
    if (!std::regex_search(text, found, std::regex(R"(project\(dstns VERSION (\d+\.\d+\.\d+))"))) stop("no version in CMakeLists.txt");
    return found[1];
}

// ------------------------------------------------------------------------------------------------------------ metadata

int metadata() {
    const auto v = version();
    const auto revision = must({"git", "-C", root().string(), "rev-parse", "HEAD"});
    const auto ref = env("GITHUB_REF");
    if (ref.starts_with("refs/tags/") && ref != "refs/tags/v" + v) stop("Release tag must be v" + v + ", matching CMakeLists.txt");
    // Only main and the exact version tag advance the public stable channel.
    const auto channel = ref == "refs/heads/main" || ref == "refs/tags/v" + v ? "stable" : "edge";
    char created[32];
    const auto moment = std::time(nullptr);
    std::strftime(created, sizeof created, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&moment));
    const auto text = "version=" + v + "\nrevision=" + revision + "\ncreated=" + created + "\nchannel=" + channel + "\n";
    if (!env("GITHUB_OUTPUT").empty()) std::ofstream(env("GITHUB_OUTPUT"), std::ios::app) << text;
    std::cout << text;
    return 0;
}

// ------------------------------------------------------------------------------------------------------------- publish

int publish(const fs::path& directory) {
    const auto image = env("IMAGE");
    const auto meta = json::parse(env("META"));
    std::vector<std::string> digests;
    for (const auto& entry : fs::directory_iterator(directory)) digests.push_back(entry.path().filename().string());
    std::sort(digests.begin(), digests.end());
    const std::regex hex("[0-9a-f]{64}");
    if (digests.size() != 2 || !std::all_of(digests.begin(), digests.end(), [&](const std::string& d) { return std::regex_match(d, hex); })) {
        stop("Expected exactly two verified platform digests");
    }
    const auto candidate = image + ":candidate-" + env("GITHUB_RUN_ID") + "-" + env("GITHUB_RUN_ATTEMPT");
    std::vector<std::string> create{"docker", "buildx", "imagetools", "create"};
    for (const auto& annotation : meta.value("annotations", json::array())) create.insert(create.end(), {"--annotation", annotation.get<std::string>()});
    create.insert(create.end(), {"-t", candidate});
    for (const auto& digest : digests) create.push_back(image + "@sha256:" + digest);
    must(create);
    std::set<std::pair<std::string, std::string>> platforms;
    const auto index = json::parse(must({"docker", "buildx", "imagetools", "inspect", "--raw", candidate}));
    for (const auto& manifest : index.at("manifests")) {
        platforms.insert({manifest.at("platform").at("os").get<std::string>(), manifest.at("platform").at("architecture").get<std::string>()});
    }
    if (!platforms.contains({"linux", "amd64"}) || !platforms.contains({"linux", "arm64"})) stop("Missing required platforms: linux/amd64 and linux/arm64 are both needed");
    // Resolve once, and promote that immutable index, attestations and all.
    const auto digest = json::parse(must({"docker", "buildx", "imagetools", "inspect", candidate, "--format", "{{json .Manifest}}"})).at("digest").get<std::string>();
    std::vector<std::string> promote{"docker", "buildx", "imagetools", "create"};
    for (const auto& tag : meta.at("tags")) promote.insert(promote.end(), {"-t", tag.get<std::string>()});
    promote.push_back(image + "@" + digest);
    must(promote);
    // Read every alias back, to catch a registry or tagging fault.
    for (const auto& tag : meta.at("tags")) {
        const auto pointed = json::parse(must({"docker", "buildx", "imagetools", "inspect", tag.get<std::string>(), "--format", "{{json .Manifest}}"})).at("digest");
        if (pointed != digest) stop(tag.get<std::string>() + " does not point to tested index " + digest);
    }
    std::cout << "Published " << image << "@" << digest << " for linux/amd64 and linux/arm64\n";
    if (!env("GITHUB_STEP_SUMMARY").empty()) {
        std::ofstream summary(env("GITHUB_STEP_SUMMARY"), std::ios::app);
        summary << "Published `" << image << "@" << digest << "` after native AMD64/ARM64 smoke tests and CI.\n\n";
        for (const auto& tag : meta.at("tags")) summary << "- `" << tag.get<std::string>() << "`\n";
    }
    return 0;
}

// --------------------------------------------------------------------------------------------------------------- smoke

void expect(bool ok, const std::string& what) {
    if (!ok) throw std::runtime_error(what);
}

int smoke(const std::string& image, const std::string& arch, const std::string& revision) {
    const auto v = version();
    const auto observer = json::parse(read(root() / "WebKit/package.json")).at("version").get<std::string>();
    const auto info = json::parse(must({"docker", "image", "inspect", image}))[0];
    expect(info.at("Architecture") == arch, "architecture is " + info.at("Architecture").dump());
    const auto labels = info.at("Config").at("Labels");
    expect(labels.at("org.opencontainers.image.version") == v, "the version label");
    expect(labels.at("org.opencontainers.image.authors").get<std::string>().starts_with("Varun Karthic"), "the authors label");
    expect(labels.at("org.opencontainers.image.licenses") == "AGPL-3.0-or-later", "the licence label");
    expect(info.at("Config").at("User") == "dstns", "the user");
    if (!revision.empty()) expect(labels.at("org.opencontainers.image.revision") == revision, "the revision label");

    std::random_device device;
    std::ostringstream name;
    name << "dstns-smoke-" << std::hex << device() << device();
    try {
        must({"docker", "run", "-d", "--name", name.str(), "-p", "127.0.0.1::8090", "-e", "DSTNS_SEED=382923", "-e", "DSTNS_DISABLE_WORLD_REGENERATION=1",
              "-e", "DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml", image});
        const auto mapped = must({"docker", "port", name.str(), "8090/tcp"});
        httplib::Client client("127.0.0.1", std::stoi(mapped.substr(mapped.rfind(':') + 1)));
        client.set_read_timeout(std::chrono::seconds(5));
        const auto get = [&](const std::string& path) {
            auto reply = client.Get(path);
            if (!reply) throw std::runtime_error("GET " + path + " failed");
            return reply;
        };
        const auto get_json = [&](const std::string& path) { return json::parse(get(path)->body); };
        json status;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(120);
        while (true) {
            try {
                status = get_json("/api/v1/playback/status");
                if (status.at("data").at("lifecycle") == "RUNNING" && run({"docker", "inspect", "--format", "{{.State.Health.Status}}", name.str()}).out == "healthy") break;
            } catch (const std::exception&) {
            }
            expect(std::chrono::steady_clock::now() < deadline, "the container never became healthy with a running simulation");
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        expect(get_json("/health").at("version") == v, "/health's version");
        const auto runtime = get_json("/api/v1/system/info");
        expect(runtime.at("version") == v, "the runtime version");
        const auto& build = runtime.at("build");
        expect(build.at("revision") == labels.at("org.opencontainers.image.revision") && build.at("channel") == labels.at("io.dstns.channel") &&
                   build.at("created") == labels.at("org.opencontainers.image.created") && build.at("type") == "Release",
               "the build it reports: " + build.dump());
        const auto packaged = json::parse(must({"docker", "exec", name.str(), "cat", "/app/build-info.json"}));
        expect(packaged.at("version") == v && packaged.at("observer_version") == observer && packaged.at("revision") == build.at("revision") &&
                   packaged.at("platform") == "linux/" + arch,
               "build-info.json: " + packaged.dump());
        const auto cli = must({"docker", "exec", name.str(), "/app/build/dstns_server", "--version"});
        expect(cli.find("DSTNS " + v) != std::string::npos && cli.find(packaged.at("revision").get<std::string>()) != std::string::npos, "--version: " + cli);
        expect(must({"docker", "exec", name.str(), "id", "-u"}) == "10001", "it runs as user 10001");
        for (const char* path : {"/app/LICENSE", "/app/COPYRIGHT"}) must({"docker", "exec", name.str(), "test", "-s", path});
        const auto topology = get_json("/api/v1/view/topology").at("data");
        expect(topology.at("nodes").size() > 100 && topology.at("edges").size() > 100, "a whole map");
        const auto html = get("/")->body;
        const std::regex asset(R"re((?:src|href)="(/assets/[^"]+)")re");
        int assets = 0;
        for (auto it = std::sregex_iterator(html.begin(), html.end(), asset); it != std::sregex_iterator(); ++it, ++assets) {
            const auto served = get((*it)[1]);
            expect(served->status == 200 && !served->body.empty(), "the observer's " + (*it)[1].str());
        }
        expect(assets > 0, "the observer's bundle in the page");
        // A new run, through the operator's helper in the image.
        must({"docker", "exec", name.str(), "dstns-run", "--seed", "42"});
        const auto replaced = get_json("/api/v1/playback/status");
        expect(replaced.at("data").at("lifecycle") == "RUNNING" && replaced.at("seed") == "42" && replaced.at("run_id") != status.at("run_id"), "the replacement run");
        must({"docker", "stop", "--time", "20", name.str()});
        const auto state = json::parse(must({"docker", "inspect", name.str()}))[0].at("State");
        expect(state.at("OOMKilled") == false && state.at("ExitCode") != 137, "a clean stop: " + state.dump());
        std::cout << "PASS " << arch << ": health, running map, observer assets, provenance, non-root, run replacement, shutdown\n";
    } catch (const std::exception& error) {
        run({"docker", "logs", "--tail", "60", name.str()});
        run({"docker", "rm", "-fv", name.str()});
        stop(std::string("FAIL: ") + error.what());
    }
    run({"docker", "rm", "-fv", name.str()});
    return 0;
}

// ------------------------------------------------------------------------------------------------------------- headers

const std::string SPDX = "SPDX-License-Identifier: AGPL-3.0-or-later";
const std::string COPYRIGHT = "Copyright (C) 2026 Varun Karthic";

// The header in the file's own comment syntax, or none for a file that is not source.
std::vector<std::string> header_for(const fs::path& path) {
    static const std::set<std::string> slash{".cpp", ".hpp", ".h", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs"};
    static const std::set<std::string> hash{".sh", ".py", ".toml"};
    static const std::set<std::string> named{"launcher", "CMakeLists.txt", "Dockerfile", "dstns-run"};
    static const std::set<std::string> block{".css"};
    const auto ext = path.extension().string();
    if (path.filename() == "package-lock.json" || path.filename() == "Cargo.lock") return {};
    if (slash.contains(ext)) return {"// " + SPDX, "// " + COPYRIGHT};
    if (hash.contains(ext) || named.contains(path.filename().string())) return {"# " + SPDX, "# " + COPYRIGHT};
    if (block.contains(ext)) return {"/* " + SPDX, "   " + COPYRIGHT + " */"};
    return {};
}

int headers(bool fix) {
    // Never touched: generated, vendored or data.
    static const std::set<std::string> skip{"node_modules", "dist", "build", "data", "docs", "site", "target"};
    std::istringstream listed(must({"git", "-C", root().string(), "ls-files"}));
    std::vector<std::string> missing;
    for (std::string name; std::getline(listed, name);) {
        const fs::path path(name);
        if (std::any_of(path.begin(), path.end(), [](const fs::path& part) { return skip.contains(part.string()); })) continue;
        const auto header = header_for(path);
        if (header.empty() || !fs::exists(root() / path)) continue;
        const auto text = read(root() / path);
        std::istringstream lines(text);
        bool found = false;
        int seen = 0;
        for (std::string line; seen < 6 && std::getline(lines, line); ++seen) found = found || line.find("SPDX-License-Identifier") != std::string::npos;
        if (found) continue;
        missing.push_back(name);
        if (fix) {
            // After a shebang, or a Dockerfile's parser directive: both must stay first.
            std::size_t at = 0;
            if (text.starts_with("#!") || (path.filename() == "Dockerfile" && text.starts_with("# syntax="))) at = text.find('\n') + 1;
            std::ofstream(root() / path, std::ios::binary) << text.substr(0, at) << header[0] << '\n' << header[1] << "\n\n" << text.substr(at);
        }
    }
    if (fix) {
        std::cout << "added a licence header to " << missing.size() << " file(s)\n";
        return 0;
    }
    for (const auto& name : missing) std::cout << "missing licence header: " << name << '\n';
    if (!missing.empty()) {
        std::cerr << '\n' << missing.size() << " file(s) lack the header. Run: dstns_release headers --fix\n";
        return 1;
    }
    std::cout << "every source file has a licence header\n";
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    const std::vector<std::string> args(argv + 1, argv + argc);
    const auto option = [&](const std::string& name) {
        auto at = std::find(args.begin(), args.end(), name);
        return at != args.end() && at + 1 != args.end() ? *(at + 1) : std::string();
    };
    const auto has = [&](const std::string& name) { return std::find(args.begin(), args.end(), name) != args.end(); };
    const auto command = args.empty() ? "" : args[0];
    if (command == "metadata") return metadata();
    if (command == "publish" && !option("--digests").empty()) return publish(option("--digests"));
    if (command == "smoke" && args.size() > 1 && !option("--arch").empty()) return smoke(args[1], option("--arch"), option("--revision"));
    if (command == "headers" && (has("--check") || has("--fix"))) return headers(has("--fix"));
    std::cerr << "usage: dstns_release metadata | publish --digests <dir> | smoke <image> --arch <amd64|arm64> [--revision <sha>] | headers --check|--fix\n";
    return 2;
}
