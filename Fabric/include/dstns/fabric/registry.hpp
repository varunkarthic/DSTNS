// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace dstns::fabric {

/// A request refused for a reason the API reports by code and status.
class Refusal : public std::runtime_error {
public:
    Refusal(int status_code, std::string error_code, const std::string& message)
        : std::runtime_error(message), status(status_code), code(std::move(error_code)) {}
    int status;
    std::string code;
};

/// The applications that have registered themselves with this server.
///
/// An application is an API client: it posts a manifest, receives a token, and
/// from then on declares what it wants on screen as data. The observer reads
/// that state and renders it, so an application never touches the page itself.
/// Thread-safe. Identity, grants and settings survive a restart; everything an
/// application declares at run time it declares again when it returns.
class AppRegistry {
public:
    explicit AppRegistry(std::filesystem::path store);

    /// `presented` is the bearer token, if any: it proves ownership of an ID.
    nlohmann::json register_app(const nlohmann::json& manifest, const std::string& presented);
    void authenticate(const std::string& id, const std::string& token);
    void require_capability(const std::string& id, const std::string& capability);

    [[nodiscard]] nlohmann::json list();
    [[nodiscard]] nlohmann::json describe(const std::string& id);
    /// The observer's view. Unchanged since `since` answers without the apps.
    [[nodiscard]] nlohmann::json state(std::uint64_t since, std::uint64_t notifications_since);

    void remove(const std::string& id, bool forget);
    void heartbeat(const std::string& id);
    void set_state(const std::string& id, const std::string& state, const std::string& detail);
    void suspend(const std::string& id, bool suspended);
    void report_failure(const std::string& id, const std::string& detail);

    void set_ui(const std::string& id, const nlohmann::json& elements);
    void upsert_element(const std::string& id, const std::string& element, const nlohmann::json& value);
    void remove_element(const std::string& id, const std::string& element);

    std::uint64_t notify(const std::string& id, const nlohmann::json& notification);

    /// Lossless within the retained window; `dropped` says if a cursor fell behind it.
    [[nodiscard]] nlohmann::json events(const std::string& id, std::uint64_t since);
    void post_event(const std::string& id, const std::string& type, const nlohmann::json& data);

    [[nodiscard]] nlohmann::json settings(const std::string& id);
    nlohmann::json update_settings(const std::string& id, const nlohmann::json& changes);
    nlohmann::json reset_settings(const std::string& id);

    nlohmann::json set_grants(const std::string& id, const nlohmann::json& capabilities);

    void audit(const std::string& id, const std::string& action, const nlohmann::json& params,
               const std::string& run_id, double virtual_s, const std::string& outcome);
    [[nodiscard]] nlohmann::json audit_log(std::size_t limit);

private:
    using Clock = std::chrono::steady_clock;
    struct App {
        std::string id, token, state{"registered"}, detail;
        nlohmann::json manifest;
        std::set<std::string> granted;
        bool user_suspended{};
        bool lease_lapsed{};
        Clock::time_point last_seen{};
        double lease_s{60};
        nlohmann::json elements = nlohmann::json::array();
        nlohmann::json values = nlohmann::json::object();
        int settings_version{};
        std::deque<nlohmann::json> event_queue;
        std::uint64_t event_sequence{};
        double bucket{};
        Clock::time_point bucket_at{};
        std::uint64_t order{};
    };

    App& find(const std::string& id);
    void touch(App& app);
    void sweep();
    void changed() { ++revision_; }
    void persist();
    void push_event(App& app, const std::string& type, const nlohmann::json& data);
    void adopt_settings(App& app);
    [[nodiscard]] nlohmann::json public_view(const App& app, bool with_ui) const;
    void check_element(const App& app, const nlohmann::json& element) const;
    [[nodiscard]] std::size_t ui_bytes(const nlohmann::json& elements) const;

    std::filesystem::path store_;
    std::mutex mutex_;
    std::map<std::string, App> apps_;
    std::deque<nlohmann::json> notifications_;
    std::deque<nlohmann::json> audit_;
    std::uint64_t revision_{1}, notification_sequence_{}, audit_sequence_{}, next_order_{};
};

} // namespace dstns::fabric
