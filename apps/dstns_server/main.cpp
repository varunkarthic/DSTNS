// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/compute/vulkan.hpp"
#include "dstns/logging.hpp"
#include "dstns/osm_fetch.hpp"

#include <cstdlib>
#include <exception>
#include <iostream>
#include <fstream>
#include <filesystem>
#include <string>

int main(int argc, char** argv) {
    try {
        // Loopback by default: the API can drive a run and write files, so it is
        // reachable from other machines only when the operator says so (--host).
        std::string host = "127.0.0.1", logs = "logs", maps = "data/maps", cache_policy = "prune";
        std::uint16_t port = 8090;
        std::size_t cache_keep = 1;
        // Compute: defaults, then DSTNS_* environment variables, then flags.
        dstns::compute::ComputeOptions compute;
        compute.apply_environment();
        bool gpu_diagnostics = false;
        for (int i = 1; i < argc; ++i) {
            std::string a = argv[i];
            if (a == "--host" && i + 1 < argc) host = argv[++i];
            else if (a == "--port" && i + 1 < argc) {
                // Checked before narrowing: 70000 would otherwise wrap to 4464.
                const auto value = std::stoul(argv[++i]);
                if (value < 1 || value > 65535) throw std::invalid_argument("--port must be in [1, 65535]");
                port = static_cast<std::uint16_t>(value);
            }
            else if (a == "--logs" && i + 1 < argc) logs = argv[++i];
            else if (a == "--maps" && i + 1 < argc) maps = argv[++i];
            else if (a == "--map-cache" && i + 1 < argc) cache_policy = argv[++i];
            else if (a == "--map-cache-keep" && i + 1 < argc) cache_keep = std::stoul(argv[++i]);
            else if (a == "--compute" && i + 1 < argc) compute.backend = dstns::compute::parse_preference(argv[++i]);
            else if (a == "--gpu-device" && i + 1 < argc) compute.device = argv[++i];
            else if (a == "--compute-cache" && i + 1 < argc) compute.cache_dir = argv[++i];
            else if (a == "--allow-software-vulkan") compute.allow_software_vulkan = true;
            else if (a == "--require-vulkan") compute.require_vulkan = true;
            else if (a == "--compute-verify") compute.verify = true;
            else if (a == "--vulkan-validation") compute.validation = true;
            else if (a == "--gpu-diagnostics") gpu_diagnostics = true;
            else if (a == "--version") {
                std::cout << "DSTNS " << DSTNS_VERSION << "\n"
                          << "Copyright (C) 2026 Varun Karthic\n"
                          << "Licence AGPL-3.0-or-later <https://www.gnu.org/licenses/agpl-3.0.html>.\n"
                          << "This is free software: you are free to change and redistribute it.\n"
                          << "There is NO WARRANTY, to the extent permitted by law.\n";
                return 0;
            }
            else if (a == "--help") {
                std::cout << "dstns_server [--host ADDR (default 127.0.0.1)] [--port PORT] [--logs DIR] [--maps DIR]\n"
                             "             [--map-cache keep|prune|clear] [--map-cache-keep N]\n"
                             "             [--compute auto|cpu|vulkan] [--gpu-device auto|INDEX|UUID|NAME]\n"
                             "             [--allow-software-vulkan] [--require-vulkan] [--compute-verify]\n"
                             "             [--vulkan-validation] [--compute-cache DIR] [--gpu-diagnostics]\n"
                             "             [--version]\n"
                             "  --gpu-diagnostics  test every Vulkan device (allocate, dispatch, read back),\n"
                             "                     print the report as JSON and exit: 0 if a device is usable,\n"
                             "                     3 if DSTNS would run on the CPU\n";
                return 0;
            } else {
                throw std::invalid_argument("unknown argument: " + a);
            }
        }
        if (gpu_diagnostics) {
            const auto report = dstns::compute::vulkan_diagnostics(compute);
            std::cout << report.dump(2) << '\n';
            return report.value("available", false) ? 0 : 3;
        }
        std::filesystem::create_directories(logs);
        const auto token_path=std::filesystem::path(logs)/"operator.token";
        const auto token=std::getenv("DSTNS_OPERATOR_TOKEN") ? std::string(std::getenv("DSTNS_OPERATOR_TOKEN")) : dstns::Seed128::secure().hex()+dstns::Seed128::secure().hex();
        {std::ofstream token_file(token_path);if(!token_file)throw std::runtime_error("cannot write operator credential");token_file<<token;}
        std::filesystem::permissions(token_path,std::filesystem::perms::owner_read|std::filesystem::perms::owner_write);
        setenv("DSTNS_OPERATOR_TOKEN",token.c_str(),1);
        dstns::RuntimeLogger logger(logs);
        // Downloaded city extracts are tens of megabytes each. Sweep them once
        // at startup so a long-lived install cannot accumulate one per city it
        // has ever visited; the newest is kept so the usual case of re-running
        // the same city stays offline.
        try {
            const auto swept = dstns::sweep_map_cache(maps, dstns::parse_cache_policy(cache_policy), cache_keep);
            if (swept.removed) {
                logger.system("INFO", "maps",
                    "Cache sweep removed " + std::to_string(swept.removed) + " extract(s), freed "
                    + std::to_string(swept.freed_bytes / (1024 * 1024)) + " MiB, kept "
                    + std::to_string(swept.kept));
            }
        } catch (const std::exception& e) {
            logger.system("WARN", "maps", std::string("Cache sweep skipped: ") + e.what());
        }
        dstns::SimulationEngine engine(logger, compute);
        // Bring the accelerator up now, so system information reports it from
        // the start; with --require-vulkan, refuse to run without it.
        engine.initialize_compute();
        dstns::ApiServer api(engine, logger);
        api.listen(host, port);
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "DSTNS fatal: " << e.what() << '\n';
        return 1;
    }
}
