// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/utf8.hpp"
#include "support.hpp"

#include <algorithm>

namespace dstns {
using namespace fabric;

// News, logs and the one-shot event streams.
void ApiServer::routes_observation() {
    // News API
    server_->Get("/api/v1/news", [this](const auto& req, auto& r) {
        send(r, engine_.news(
            unsigned_parameter(req, "since_news_id", 0),
            static_cast<std::size_t>(std::min<std::uint64_t>(500, unsigned_parameter(req, "limit", 100))),
            unsigned_parameter(req, "since_narration", 0),
            // Realistic News is the observer's; other clients get the core's
            // feed unless they ask for it by name.
            req.get_param_value("narration") == "realistic"
        ));
    });

    // Logs API
    server_->Get("/api/v1/view/logs/system", [this](const auto&, auto& r) {
        send(r, {{"ok", true}, {"data", {{"lines", logger_.system_tail(250)}}}});
    });
    server_->Get("/api/v1/view/logs/events", [this](const auto& req, auto& r) {
        const auto limit = static_cast<std::size_t>(std::min<std::uint64_t>(1000, unsigned_parameter(req, "limit", 100)));
        send(r, {{"ok", true}, {"data", {{"items", logger_.rows("event_log", limit)}}}});
    });
    server_->Get("/api/v1/view/logs/api", [this](const auto& req, auto& r) {
        const auto limit = static_cast<std::size_t>(std::min<std::uint64_t>(1000, unsigned_parameter(req, "limit", 100)));
        send(r, {{"ok", true}, {"data", {{"items", logger_.rows("api_log", limit)}}}});
    });

    // Streaming
    server_->Get("/api/v1/view/stream", [this](const auto&, auto& r) {
        r.set_header("Connection", "close");
        r.set_content("retry: 1000\nevent: snapshot\ndata: " + dump_json(engine_.snapshot()) + "\n\n", "text/event-stream");
    });
    server_->Get("/api/v1/news/stream", [this](const auto&, auto& r) {
        r.set_header("Connection", "close");
        r.set_content("retry: 1000\nevent: news\ndata: " + dump_json(engine_.news(0, 100)) + "\n\n", "text/event-stream");
    });
}
} // namespace dstns
