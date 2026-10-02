// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/calendar.hpp"
#include "dstns/compute/vulkan.hpp"
#include "dstns/logging.hpp"
#include "dstns/osm_fetch.hpp"

#include <cstdlib>
#include <exception>
#include <iostream>
#include <fstream>
#include <filesystem>
#include <optional>
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
        // Seed tools: answer from the seed and the catalogue alone, then exit.
        std::optional<std::string> describe_seed_value;
        bool generate_seed = false;
        std::string want_location, want_month, want_day;
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
            else if (a == "--describe-seed" && i + 1 < argc) describe_seed_value = argv[++i];
            else if (a == "--generate-seed") generate_seed = true;
            else if (a == "--location" && i + 1 < argc) want_location = argv[++i];
            else if (a == "--month" && i + 1 < argc) want_month = argv[++i];
            else if (a == "--day-type" && i + 1 < argc) want_day = argv[++i];
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
                             "             [--describe-seed SEED]\n"
                             "             [--generate-seed [--location CITY] [--month MONTH] [--day-type weekday|weekend]]\n"
                             "             [--version]\n"
                             "  --gpu-diagnostics  test every Vulkan device (allocate, dispatch, read back),\n"
                             "                     print the report as JSON and exit: 0 if a device is usable,\n"
                             "                     3 if DSTNS would run on the CPU\n"
                             "  --describe-seed    print the location, month and day type a seed resolves to\n"
                             "  --generate-seed    print a fresh seed that resolves to the given location,\n"
                             "                     month and day type (each optional; omitted means any)\n";
                return 0;
            } else {
                throw std::invalid_argument("unknown argument: " + a);
            }
        }
        if (describe_seed_value || generate_seed) {
            const auto print = [](const dstns::Seed128& seed, const dstns::SeedMetadata& m, std::uint64_t attempts) {
                nlohmann::json out{{"seed", seed.decimal()}, {"seed_hex", seed.hex()},
                                   {"location", {{"city", m.city}, {"country", m.country}, {"latitude", m.latitude}, {"longitude", m.longitude}}},
                                   {"month", m.month}, {"month_name", dstns::month_name(m.month)},
                                   {"day", m.day}, {"day_type", dstns::day_type_name(m.day)}};
                if (attempts) out["candidates_examined"] = attempts;
                std::cout << out.dump(2) << '\n';
            };
            if (describe_seed_value) {
                const auto& text = *describe_seed_value;
                const auto seed = text.starts_with("0x") || text.starts_with("0X") ? dstns::Seed128::parse(text) : dstns::Seed128::from_decimal(text);
                print(seed, dstns::describe_seed(seed), 0);
                return 0;
            }
            dstns::SeedConstraints c;
            const auto given = [](const std::string& v) { return !v.empty() && v != "auto" && v != "Auto"; };
            if (given(want_location) && !(c.city_index = dstns::find_city(want_location)))
                throw std::invalid_argument("unknown location: " + want_location);
            if (given(want_month) && !(c.month = dstns::parse_month(want_month)))
                throw std::invalid_argument("--month must be 1..12, a month name, or auto");
            if (given(want_day) && !(c.day = dstns::parse_day_type(want_day)))
                throw std::invalid_argument("--day-type must be weekday, weekend or auto");
            const auto found = dstns::generate_constrained_seed(c);
            print(found.seed, found.metadata, found.attempts);
            return 0;
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
