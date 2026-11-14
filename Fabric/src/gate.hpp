// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The unstable-engine gate (docs/design/engine-governance.md).
//
// config/engines.json says, for each engine, whether it may be used and how a run on it must be acknowledged. A start
// on an alpha or beta engine whose acknowledgment is enforced is held, not run: the gate moves to "pending", and
// nothing that runs the engine is done for anyone until a person accepts it in the observer (or the operator in the
// launcher). Accepting runs the held start, once. Rejecting drops it; the person may then end the server or start the
// same seed, and only the seed, on an enabled stable engine. Approval is per run and lives only in the server, so no
// cache in a browser can satisfy it.
//
// The gate's states and the moves between them are a table (allowed), checked on every move.
#pragma once

#include <nlohmann/json.hpp>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace dstns::fabric {

// One engine's policy. An engine that is not enabled stays installed but cannot start. Enforcement holds a start
// until it is acknowledged; ui shows the acknowledgment in the observer. Enforcement off turns the observer's
// acknowledgment off with it; ui off with enforcement on leaves the acknowledgment to the launcher.
struct EnginePolicy {
    bool enabled{true};
    bool ui{true};
    bool enforce{true};
};

struct EngineConfig {
    int schema_version{1};
    std::string selected{"core-ng"};
    std::string default_engine{"core-ng"};
    // What a rejection offers: "offer" lists the enabled stable real engines to start the seed on; "off" offers none.
    std::string auto_switch{"offer"};
    std::map<std::string, EnginePolicy> engines;
    std::vector<std::string> warnings;  // what was wrong in the file, and what was used instead

    [[nodiscard]] EnginePolicy policy(const std::string& id) const;
    [[nodiscard]] nlohmann::json to_json() const;
    // The file, or the defaults if there is none. A file that cannot be read gives the defaults and a warning: a
    // mistyped file must not stop the server, and the defaults are the safe ones (every acknowledgment enforced).
    static EngineConfig load(const std::filesystem::path& file);
    static EngineConfig parse(const nlohmann::json& file);
};

namespace gate {
// The gate's states: none (no run waiting), pending, accepted, rejected, cancelled (the operator stopped or replaced
// the run before anyone decided).
bool allowed(const std::string& from, const std::string& to);
} // namespace gate

class EngineGate {
public:
    using Notify = std::function<void(const nlohmann::json&)>;
    EngineGate(EngineConfig config, Notify notify);

    [[nodiscard]] const EngineConfig& config() const { return config_; }
    // Whether a start on this engine, with this identity, must wait for acknowledgment.
    [[nodiscard]] bool gated(const nlohmann::json& identity) const;
    // Refuses an engine that is disabled (403 ENGINE_DISABLED).
    void require_enabled(const std::string& engine) const;

    // Hold a start. The same Idempotency-Key while it waits gives the same answer; another start while one waits is
    // refused (409 APPROVAL_PENDING): the operator stops the waiting one first.
    nlohmann::json hold(const nlohmann::json& request, const nlohmann::json& identity, const std::string& idempotency_key);
    // A decision. Returns the held start to run on accept, or nothing. The same decision twice is the same answer;
    // the other decision after one is made is refused (409 APPROVAL_DECIDED).
    struct Decision {
        nlohmann::json answer;
        std::optional<nlohmann::json> run;  // the request to start now, if any
    };
    Decision decide(const std::string& id, const std::string& decision, const std::string& then, const std::string& engine, const nlohmann::json& catalogue);
    // The operator stopped, reset or replaced the run while one waited.
    void cancel(const std::string& why);
    // A run that was accepted has ended: the next start on a gated engine needs acknowledging again.
    void run_ended();

    [[nodiscard]] bool pending() const;
    [[nodiscard]] nlohmann::json state(const nlohmann::json& catalogue) const;
    // Wait until the gate's revision is past since, or the timeout passes: a long poll for clients to retry on.
    nlohmann::json wait(std::uint64_t since, std::chrono::milliseconds timeout, const nlohmann::json& catalogue);
    // What a request that would run the engine gets while a start waits.
    [[nodiscard]] nlohmann::json deferred(const std::string& request_id) const;

private:
    [[nodiscard]] nlohmann::json deferred_locked(const std::string& request_id) const;
    void move(const std::string& to);  // under the lock
    [[nodiscard]] nlohmann::json state_locked(const nlohmann::json& catalogue) const;
    [[nodiscard]] nlohmann::json alternatives(const nlohmann::json& catalogue, const std::string& rejected) const;

    EngineConfig config_;
    Notify notify_;
    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::string state_{"none"};
    std::uint64_t revision_{0};
    std::string id_, key_, decision_, then_, reason_;
    nlohmann::json request_, identity_, outcome_;
    std::chrono::system_clock::time_point since_{};
};

} // namespace dstns::fabric
