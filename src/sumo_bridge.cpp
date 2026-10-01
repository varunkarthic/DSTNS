#include "dstns/sumo_bridge.hpp"
#include "dstns/scenario.hpp"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <sys/wait.h>

namespace dstns {
namespace {

struct ProcessResult {
    int exit_code{-1};
    std::string output;
};

ProcessResult execute_process(const std::string& cmd) {
    std::array<char, 256> buffer;
    ProcessResult result;
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) return result;
    while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
        result.output += buffer.data();
    }
    const int status = pclose(pipe);
    result.exit_code = (status != -1 && WIFEXITED(status)) ? WEXITSTATUS(status) : -1;
    return result;
}

// Single-quote a value for /bin/sh. Paths reach these commands from API
// request bodies, so every one is quoted rather than trusted.
std::string shell_quote(const std::string& value) {
    std::string quoted = "'";
    for (const char c : value) {
        if (c == '\'') quoted += "'\\''";
        else quoted += c;
    }
    return quoted + "'";
}

std::filesystem::path find_executable(const std::string& name) {
    const char* sumo_home = std::getenv("SUMO_HOME");
    if (sumo_home && *sumo_home && std::filesystem::exists(std::filesystem::path(sumo_home) / "bin" / name)) {
        return std::filesystem::path(sumo_home) / "bin" / name;
    }
    // Common installation prefixes, checked when SUMO_HOME is unset.
    const std::array<std::filesystem::path, 4> candidates = {
        std::filesystem::path("/opt/homebrew/bin") / name,
        std::filesystem::path("/usr/local/bin") / name,
        std::filesystem::path("/usr/bin") / name,
        std::filesystem::path("/app/bin") / name
    };
    for (const auto& p : candidates) {
        if (std::filesystem::exists(p)) return p;
    }
    const auto which_out = execute_process("command -v " + shell_quote(name) + " 2>/dev/null");
    if (which_out.exit_code == 0 && !which_out.output.empty()) {
        std::string p = which_out.output;
        while (!p.empty() && (p.back() == '\n' || p.back() == '\r')) p.pop_back();
        if (std::filesystem::exists(p)) return p;
    }
    return {};
}

} // namespace

SumoEnvironment SumoBridge::detect() {
    SumoEnvironment env;
    env.sumo_binary = find_executable("sumo");
    env.netconvert_binary = find_executable("netconvert");

    const char* sh = std::getenv("SUMO_HOME");
    if (sh && *sh && std::filesystem::exists(sh)) {
        env.sumo_home = sh;
    } else if (!env.sumo_binary.empty()) {
        env.sumo_home = env.sumo_binary.parent_path().parent_path();
    }

    // A binary that exists but cannot start (a missing shared library, the
    // wrong architecture) is not available: each tool must answer --version.
    bool sumo_runs = false;
    if (!env.sumo_binary.empty()) {
        const auto v_out = execute_process(shell_quote(env.sumo_binary.string()) + " --version 2>&1");
        sumo_runs = v_out.exit_code == 0;
        // Development builds print a tag such as "v1_27_1+0354-22511947e85";
        // releases print "Version 1.15.0". A bare "v[0-9]" would also match
        // the "GPLv2" in the licence text, so each form is matched exactly.
        std::smatch m;
        if (sumo_runs && std::regex_search(v_out.output, m, std::regex(R"(\bv\d+_\d+_\d+(\+[0-9a-f-]+)?)"))) {
            env.sumo_version = m[0];
        } else if (sumo_runs && std::regex_search(v_out.output, m, std::regex(R"(Version (\d+\.\d+\.\d+))"))) {
            env.sumo_version = m[1];
        } else if (sumo_runs) {
            env.sumo_version = "available";
        }
    }
    bool netconvert_runs = false;
    if (!env.netconvert_binary.empty()) {
        netconvert_runs = execute_process(shell_quote(env.netconvert_binary.string()) + " --version >/dev/null 2>&1").exit_code == 0;
    }

    env.available = sumo_runs && netconvert_runs;
    return env;
}

void SumoBridge::export_bundle(const Scenario& scenario, const std::filesystem::path& directory) {
    ScenarioCompiler compiler;
    compiler.export_sumo(scenario, directory);
}

bool SumoBridge::build_network(const std::filesystem::path& directory, const SumoEnvironment& env, std::string& error_out) {
    const auto nod = directory / "network.nod.xml";
    const auto edg = directory / "network.edg.xml";
    const auto net = directory / "network.net.xml";

    if (!std::filesystem::exists(nod) || !std::filesystem::exists(edg)) {
        error_out = "network.nod.xml or network.edg.xml missing";
        return false;
    }

    std::filesystem::remove(net);
    const std::string cmd = shell_quote(env.netconvert_binary.string()) +
        " --node-files=" + shell_quote(nod.string()) +
        " --edge-files=" + shell_quote(edg.string()) +
        " --output-file=" + shell_quote(net.string()) +
        " --no-warnings=true 2>&1";

    const auto out = execute_process(cmd);
    if (out.exit_code != 0 || !std::filesystem::exists(net)) {
        error_out = "netconvert failed: " + out.output;
        return false;
    }
    return true;
}

nlohmann::json SumoBridge::simulate(
    const Scenario& scenario,
    const std::filesystem::path& directory,
    std::uint32_t begin_s,
    std::uint32_t end_s,
    const SumoEnvironment* env_override
) {
    SumoEnvironment env = env_override ? *env_override : detect();
    if (!env.available) {
        throw std::runtime_error("SUMO simulation engine not found on system (sumo and netconvert required)");
    }

    export_bundle(scenario, directory);
    std::string err;
    if (!build_network(directory, env, err)) {
        throw std::runtime_error("Failed to build SUMO network: " + err);
    }

    const auto tripinfo = directory / "tripinfo.xml";
    const auto cfg = directory / "sandbox.sumocfg";
    std::filesystem::remove(tripinfo);

    const std::string seed_arg = std::to_string(static_cast<std::uint32_t>(scenario.seed.low & 0x7FFFFFFF));
    const std::string cmd = shell_quote(env.sumo_binary.string()) +
        " -c " + shell_quote(cfg.string()) +
        " --begin " + std::to_string(begin_s) +
        " --end " + std::to_string(end_s) +
        " --seed " + seed_arg +
        " --tripinfo-output " + shell_quote(tripinfo.string()) +
        " --no-step-log=true --duration-log.disable=true 2>&1";

    const auto out = execute_process(cmd);
    if (out.exit_code != 0) {
        throw std::runtime_error("SUMO simulation failed: " + out.output);
    }

    std::uint64_t vehicle_count = 0;
    double total_travel_time_s = 0.0;
    double total_waiting_time_s = 0.0;
    double total_route_length_m = 0.0;
    double total_loss_time_s = 0.0;

    if (std::filesystem::exists(tripinfo)) {
        std::ifstream f(tripinfo);
        std::string line;
        const std::regex dur_rx("duration=\"([0-9.]+)\"");
        const std::regex wait_rx("waitingTime=\"([0-9.]+)\"");
        const std::regex route_rx("routeLength=\"([0-9.]+)\"");
        const std::regex loss_rx("timeLoss=\"([0-9.]+)\"");

        while (std::getline(f, line)) {
            if (line.find("<tripinfo") != std::string::npos) {
                ++vehicle_count;
                std::smatch m;
                if (std::regex_search(line, m, dur_rx)) total_travel_time_s += std::stod(m[1]);
                if (std::regex_search(line, m, wait_rx)) total_waiting_time_s += std::stod(m[1]);
                if (std::regex_search(line, m, route_rx)) total_route_length_m += std::stod(m[1]);
                if (std::regex_search(line, m, loss_rx)) total_loss_time_s += std::stod(m[1]);
            }
        }
    }

    return {
        {"ok", true},
        {"engine", "SUMO"},
        {"version", env.sumo_version},
        {"simulation_period", {{"begin_s", begin_s}, {"end_s", end_s}}},
        {"vehicles_simulated", vehicle_count},
        {"mean_travel_time_s", vehicle_count > 0 ? (total_travel_time_s / vehicle_count) : 0.0},
        {"mean_waiting_time_s", vehicle_count > 0 ? (total_waiting_time_s / vehicle_count) : 0.0},
        {"mean_time_loss_s", vehicle_count > 0 ? (total_loss_time_s / vehicle_count) : 0.0},
        {"mean_route_length_m", vehicle_count > 0 ? (total_route_length_m / vehicle_count) : 0.0},
        {"bundle_directory", directory.string()},
        {"tripinfo_file", tripinfo.string()}
    };
}

} // namespace dstns
