// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Everything the server says it offers is documented: in the OpenAPI description and in Every endpoint.
#include "harness.hpp"

#include <regex>
#include <set>

using namespace check;

int main() {
    json groups;
    {
        TempDir tmp;
        Server server(tmp.path);
        groups = server.call("GET", "/api/v1/system/endpoints").body.at("groups");
    }
    std::set<std::string> openapi;
    std::istringstream spec(read(root() / "docs/api/openapi.yaml"));
    const std::regex path_line(R"(^  (/[^\s:]*):$)");
    for (std::string line; std::getline(spec, line);) {
        std::smatch found;
        if (std::regex_match(line, found, path_line)) openapi.insert(found[1]);
    }
    const auto page = read(root() / "docs/api/endpoints.md");
    const std::regex choice(R"(\{([a-z-]+(?:\|[a-z-]+)+)\})");
    std::vector<std::string> missing;
    for (const auto& group : groups) {
        for (const auto& endpoint : group.at("endpoints")) {
            const auto route = endpoint.at("path").get<std::string>();
            // A choice in the index, such as {play|pause}, stands for one route each.
            std::vector<std::string> routes{route};
            std::smatch found;
            if (std::regex_search(route, found, choice)) {
                routes.clear();
                std::stringstream options(found[1].str());
                for (std::string option; std::getline(options, option, '|');) routes.push_back(found.prefix().str() + option + found.suffix().str());
            }
            for (const auto& one : routes) {
                if (!openapi.contains(one)) missing.push_back("openapi: " + one);
                // Legacy routes are in a table of their own, by group.
                const bool legacy = one.starts_with("/api/v1/playback/") || one.starts_with("/api/v1/control/");
                const auto parent = one.substr(0, one.rfind('/'));
                if (!legacy && !contains(page, one) && !contains(page, parent)) missing.push_back("endpoints.md: " + one);
            }
        }
    }
    std::string list;
    for (const auto& item : missing) list += "\n    " + item;
    EXPECT(missing.empty(), "undocumented:" + list);
    std::cout << "docs coverage ok\n";
}
