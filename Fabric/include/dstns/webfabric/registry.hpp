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
    /// A signed request's signature, freshness and nonce. Refused if unsigned and the application requires signing.
    void verify_signature(const std::string& id, const std::string& method, const std::string& target, const std::string& timestamp,
                          const std::string& nonce, const std::string& signature, const std::string& body);
    /// Empty if the application is unknown.
    [[nodiscard]] std::string sign_response(const std::string& id, int status, const std::string& nonce, const std::string& digest);
    /// A new token and signing key. The old ones stop working at once.
    nlohmann::json rotate_credentials(const std::string& id);
    /// Each entry is chained to the one before by a hash, so that a change to any of them shows.
    [[nodiscard]] nlohmann::json audit_verify();
    /// What is protecting what, for a person to check.
    [[nodiscard]] nlohmann::json security();

    /// How the launcher should start an application. Only ever a proposal: nothing here
    /// runs, and a person has to approve it at the launcher before it can.
    nlohmann::json propose_launch(const std::string& id, const nlohmann::json& spec, const std::string& proposed_by);
    void withdraw_launch(const std::string& id);
    [[nodiscard]] nlohmann::json launch_proposals();
    /// What the launcher is starting, for the observer to say while it waits.
    void set_launch_plan(const nlohmann::json& plan);
    void require_capability(const std::string& id, const std::string& capability);

    [[nodiscard]] nlohmann::json list();
    [[nodiscard]] nlohmann::json describe(const std::string& id);
    /// The observer's view. Unchanged since `since` answers without the apps.
    [[nodiscard]] nlohmann::json state(std::uint64_t since, std::uint64_t notifications_since, std::uint64_t view_since = 0);
    /// An application asking the map to move. It only asks: the observer decides, and says what it did.
    [[nodiscard]] nlohmann::json request_view(const std::string& id, const nlohmann::json& request);
    void view_outcome(const std::string& id, std::uint64_t request, const std::string& outcome, const std::string& reason);
    /// Layers and places an application holds on or off. Held apart from a person's settings, and never saved.
    [[nodiscard]] nlohmann::json set_presentation(const std::string& id, const nlohmann::json& request);
    void clear_presentation(const std::string& id);

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

    /// What this server offers, so that an application or a tool can find out rather than assume.
    [[nodiscard]] static nlohmann::json discovery();

    /// Several elements changed at once: all of it applies, or none of it.
    void batch_ui(const std::string& id, const nlohmann::json& upsert, const nlohmann::json& remove);

    /// What of the simulation arrives in the application's events. Topics are `lifecycle`,
    /// `world`, `news`, and `news.<category>`. Nothing is sent that was not asked for.
    nlohmann::json subscribe(const std::string& id, const nlohmann::json& topics);
    /// A timer on the simulation's own clock, once at `at_s` or then every `every_s`.
    nlohmann::json set_timer(const std::string& id, const std::string& timer, const nlohmann::json& spec);
    void clear_timer(const std::string& id, const std::string& timer);
    [[nodiscard]] nlohmann::json timers(const std::string& id);
    /// Whether the application is waiting on anything the simulation does, and from which news on.
    [[nodiscard]] bool follows_simulation(const std::string& id);
    [[nodiscard]] std::uint64_t news_cursor(const std::string& id);
    /// Brings the application up to date, when it asks for its events. Costs nothing between polls.
    void pump(const std::string& id, const std::string& run_id, const std::string& lifecycle, double virtual_s, const nlohmann::json& news);

    /// A small store of the application's own, kept across restarts of either side.
    [[nodiscard]] nlohmann::json storage(const std::string& id);
    [[nodiscard]] nlohmann::json storage_get(const std::string& id, const std::string& key);
    void storage_put(const std::string& id, const std::string& key, const nlohmann::json& value);
    void storage_delete(const std::string& id, const std::string& key);

    /// Delivered as a `message` event, when both applications have asked to use messages.
    void send_message(const std::string& from, const std::string& to, const nlohmann::json& message);

    /// How the application is doing, for a person or a supervisor.
    [[nodiscard]] nlohmann::json health(const std::string& id);

    /// Nodes an application treats as its own bus stops. Presentation only: the
    /// core reports their demand and the simulation never reads them.
    void set_stops(const std::string& id, const nlohmann::json& nodes);
    [[nodiscard]] std::vector<std::uint32_t> stops(const std::string& id);

    void audit(const std::string& id, const std::string& action, const nlohmann::json& params,
               const std::string& run_id, double virtual_s, const std::string& outcome);
    [[nodiscard]] nlohmann::json audit_log(std::size_t limit);

private:
    using Clock = std::chrono::steady_clock;
    struct App {
        std::string id, token_hash, signing_key, state{"registered"}, detail;
        bool signatures_required{};
        std::map<std::string, std::int64_t> nonces;
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
        std::uint64_t changed_at{};
        std::uint64_t ui_all_at{};
        std::map<std::string, std::uint64_t> element_rev;
        std::vector<std::uint32_t> stops;
        std::set<std::string> topics;
        struct Timer { double at_s{}, every_s{}, next_s{}; bool done{}; nlohmann::json data; };
        std::map<std::string, Timer> timers;
        std::uint64_t news_seen{};
        std::string seen_run, seen_lifecycle;
        double seen_virtual{-1};
        nlohmann::json storage = nlohmann::json::object();
        Clock::time_point registered_at{};
        nlohmann::json presentation = nullptr;
        std::uint64_t presentation_at{};
        double view_bucket{4};
        Clock::time_point view_bucket_at{};
        std::uint64_t requests{}, refused{}, rate_limited{}, lapses{}, messages_sent{}, messages_received{}, dropped_events{};
    };

    App& find(const std::string& id);
    void touch(App& app);
    void spend_direction(App& app);
    void sweep();
    void mark(App& app) {
        app.changed_at = app.ui_all_at = ++revision_;
    }
    void persist();
    void push_event(App& app, const std::string& type, const nlohmann::json& data);
    void adopt_settings(App& app);
    [[nodiscard]] nlohmann::json public_view(const App& app, bool with_ui) const;
    void check_element(const App& app, const nlohmann::json& element) const;
    [[nodiscard]] std::size_t ui_bytes(const nlohmann::json& elements) const;

    std::string store_key();
    std::filesystem::path store_;
    std::string store_key_;
    std::string audit_head_;
    bool store_rejected_{};
    nlohmann::json launch_ = nlohmann::json::object();
    nlohmann::json launch_plan_ = nullptr;
    std::deque<nlohmann::json> view_requests_;
    std::uint64_t view_sequence_{};
    std::uint64_t presentation_revision_{};
    std::mutex mutex_;
    std::map<std::string, App> apps_;
    std::deque<nlohmann::json> notifications_;
    std::deque<nlohmann::json> audit_;
    std::deque<std::pair<std::uint64_t, std::string>> forgotten_;
    std::uint64_t revision_{1}, notification_sequence_{}, audit_sequence_{}, next_order_{};
};

} // namespace dstns::fabric
