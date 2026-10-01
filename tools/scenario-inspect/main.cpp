// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/scenario.hpp"
#include <cstdlib>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
    try {
        std::string out_dir;
        std::string seed_str = "0x123456789ABCDEF0";
        dstns::ScenarioConfig c;
        c.playback_duration_s = 120;
        c.grid_width = 8;
        c.grid_height = 8;
        c.dws_frequency = 2;

        for (int i = 1; i < argc; ++i) {
            std::string a = argv[i];
            if ((a == "--out" || a == "--export-sumo") && i + 1 < argc) {
                out_dir = argv[++i];
            } else if (a == "--seed" && i + 1 < argc) {
                seed_str = argv[++i];
            } else if (a == "--grid" && i + 1 < argc) {
                std::string g = argv[++i];
                auto pos = g.find('x');
                if (pos != std::string::npos) {
                    c.grid_width = static_cast<std::uint32_t>(std::stoul(g.substr(0, pos)));
                    c.grid_height = static_cast<std::uint32_t>(std::stoul(g.substr(pos + 1)));
                }
            } else if (a == "--duration" && i + 1 < argc) {
                c.playback_duration_s = static_cast<std::uint32_t>(std::stoul(argv[++i]));
            } else if (a == "--dws" && i + 1 < argc) {
                c.dws_frequency = static_cast<std::uint32_t>(std::stoul(argv[++i]));
            } else if (a == "--help") {
                std::cout << "usage: dstns_scenario_export [options] [OUT_DIR]\n"
                          << "  --out, --export-sumo DIR   Output directory for SUMO bundle\n"
                          << "  --seed SEED                Hex or integer seed\n"
                          << "  --grid WxH                 Synthetic grid dimensions\n"
                          << "  --duration SECONDS         Playback duration seconds\n"
                          << "  --dws FREQUENCY            Weather event count\n";
                return 0;
            } else if (out_dir.empty() && a[0] != '-') {
                out_dir = a;
            }
        }

        if (out_dir.empty()) {
            std::cerr << "error: output directory required\n";
            return 2;
        }

        dstns::ScenarioCompiler compiler;
        auto s = compiler.compile(dstns::Seed128::parse(seed_str), c);
        compiler.export_sumo(s, out_dir);
        std::cout << s.scenario_hash << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << '\n';
        return 1;
    }
}
