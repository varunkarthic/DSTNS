// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "support.hpp"

#include <filesystem>
#include <fstream>

namespace dstns {
using namespace fabric;

// The observer itself: its page, assets and icon.
void ApiServer::routes_static() {
    auto find_dist = []() -> std::filesystem::path {
        // The launcher builds the observer outside a cloud-synced checkout and
        // says where with DSTNS_UI_DIST.
        if (const char* chosen = std::getenv("DSTNS_UI_DIST"); chosen && *chosen && std::filesystem::exists(chosen))
            return std::filesystem::absolute(chosen);
        for (const auto& dir : {
            "ui-engine/dist",
            "../ui-engine/dist",
            "../../ui-engine/dist",
            "dist",
            "/app/ui-engine/dist"
        }) {
            if (std::filesystem::exists(dir)) return std::filesystem::absolute(dir);
        }
        return {};
    };

    const auto dist = find_dist();
    if(std::filesystem::exists("media"))server_->set_mount_point("/media",std::filesystem::absolute("media").string());
    server_->Get("/media/logo.png",[](const auto&,auto& r){r.status=404;});

    if (!dist.empty() && std::filesystem::exists(dist / "assets")) {
        server_->set_mount_point("/assets", (dist / "assets").string());
    }

    auto index_handler = [this, dist](const httplib::Request&, httplib::Response& r) {
        observer_loads_.fetch_add(1);
        if (!dist.empty() && std::filesystem::exists(dist / "index.html")) {
            std::ifstream f(dist / "index.html");
            if (f) {
                std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                r.set_content(content, "text/html; charset=utf-8");
                return;
            }
        }
        r.set_content("<!DOCTYPE html><html><head><title>DSTNS</title></head><body><h1>DSTNS Engine</h1><p>API Server active on port 8090.</p></body></html>", "text/html; charset=utf-8");
    };
    // The browser icon lives beside index.html rather than under /assets,
    // because the page references it by a fixed path.

    server_->Get("/favicon.svg", [dist](const httplib::Request&, httplib::Response& r) {
        std::ifstream f(dist / "favicon.svg");
        if (dist.empty() || !f) {
            r.status = 404;
            return;
        }
        std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        r.set_content(content, "image/svg+xml");
    });
    server_->Get("/", index_handler);
    server_->Get("/index.html", index_handler);
}
} // namespace dstns
