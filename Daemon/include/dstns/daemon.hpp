// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The daemons: small watchers, each on a thread of its own inside the server, that tell everyone what they notice.
//
//   DaemonHandler   starts, stops, turns on and off and passes signals between them
//   DaemonGateway   their two queues: daemonEmergencyQueue (alerts and emergencies), daemonNotificationQueue (the rest)
//   rcs             the Resource Control Subsystem: each module's memory and processor, against its α, β and γ
//   memory, disk    the machine's memory and disk space
//   stall           a run meant to be running whose clock has stopped
//   cache           the auto cache handler: clears what nothing needs any more
//
// Every message is one of the templates in Daemon/messages.json. The alerts raised by a reading crossing a line are in
// config/daemon-alerts.json. A condition raises anything only once it has held for its sustain time, so that a spike
// is not an alarm.

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace dstns::daemon {

using json = nlohmann::json;

/// What the daemons may ask of the rest of the server. Each answer is cheap and never waits on the engine.
struct Host {
    std::function<std::string()> lifecycle;                      // "RUNNING", "PAUSED", …
    std::function<std::optional<double>()> virtual_seconds;      // nothing while the engine is busy
    std::function<std::vector<int>()> download_groups;           // the map downloads' process groups
    std::function<std::vector<std::filesystem::path>()> keep;    // files the cache handler must never remove
    std::filesystem::path map_cache, logs;
    std::function<void(const std::string& level, const std::string& text)> log;
};

/// One message, as it is queued.
struct Message {
    std::uint64_t sequence{};
    std::string id, level, queue, daemon, title, text;
    json data;
    std::int64_t time_ms{};
    std::set<std::string> acknowledged;
    [[nodiscard]] json to_json() const;
};

/// A queue in order, with a cursor for readers, and a wait for the next message.
class Queue {
public:
    Queue(std::string name, std::size_t capacity) : name_(std::move(name)), capacity_(capacity) {}
    std::uint64_t push(Message message);
    /// After `since`, at most `limit`; with `wait_s`, waits that long for something new.
    [[nodiscard]] json read(std::uint64_t since, std::size_t limit, double wait_s, const std::string& reader);
    bool acknowledge(std::uint64_t sequence, const std::string& by);
    [[nodiscard]] json summary() const;
    void wake();
    [[nodiscard]] const std::string& name() const { return name_; }

private:
    std::string name_;
    std::size_t capacity_;
    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<Message> items_;
    std::uint64_t next_{1};
    std::map<std::string, std::chrono::steady_clock::time_point> readers_;
    bool closing_{};
};

/// The two queues, and the templates every message is made from.
class Gateway {
public:
    Gateway();
    /// A message from its template, filled in from `data`, onto the queue its level belongs to.
    std::uint64_t publish(const std::string& id, const std::string& daemon, const json& data);
    Queue& emergency() { return emergency_; }
    Queue& notification() { return notification_; }
    [[nodiscard]] const json& templates() const { return templates_; }
    void set_log(std::function<void(const std::string&, const std::string&)> log) { log_ = std::move(log); }
    void close();

private:
    json templates_;
    Queue emergency_{"daemonEmergencyQueue", 200};
    Queue notification_{"daemonNotificationQueue", 500};
    std::function<void(const std::string&, const std::string&)> log_;
};

/// A condition that counts only once it has held for `sustain` seconds; and once it no longer holds, that too.
class Sustained {
public:
    enum class Change { None, Began, Ended };
    Change update(bool holds, double sustain_s, std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now());
    [[nodiscard]] bool active() const { return reported_; }

private:
    bool holds_{}, reported_{};
    std::chrono::steady_clock::time_point since_{};
};

/// Turn a template's {name}s into what `data` holds.
[[nodiscard]] std::string fill(const std::string& text, const json& data);

class Handler;

/// A daemon: a name, what it does, and what it does each time it wakes.
class Daemon {
public:
    virtual ~Daemon() = default;
    [[nodiscard]] virtual std::string name() const = 0;
    [[nodiscard]] virtual std::string description() const = 0;
    [[nodiscard]] virtual double interval_s() const { return 1.0; }
    virtual void tick(Handler& handler) = 0;
    /// Another daemon asked, through the handler.
    virtual void signal(Handler&, const std::string& /*what*/) {}
    [[nodiscard]] json readings() const;
    void set_readings(json readings);
    std::atomic_bool enabled{true};
    std::atomic<std::int64_t> last_tick_ms{0};

private:
    mutable std::mutex readings_mutex_;
    json readings_ = json::object();
};

/// The daemons and their gateway: they start with the server and stop with it.
class Handler {
public:
    /// `settings` is what the launcher passes as DSTNS_DAEMON; `alerts` the contents of config/daemon-alerts.json.
    Handler(Host host, json settings, json alerts);
    ~Handler();
    void start();
    void stop();

    [[nodiscard]] bool enabled() const { return enabled_; }
    [[nodiscard]] Gateway& gateway() { return gateway_; }
    [[nodiscard]] const Host& host() const { return host_; }
    [[nodiscard]] json settings() const;
    [[nodiscard]] double sustain_s() const;

    /// What anyone may know, without asking first: whether it is on, which daemons run, and the queues.
    [[nodiscard]] json overview() const;
    [[nodiscard]] std::optional<json> detail(const std::string& name) const;
    /// Turn one on or off. False for a name that is not a daemon.
    bool set_enabled(const std::string& name, bool on);
    /// Change some settings while it runs (the Resource Control Subsystem's limits, the cache's budget…).
    void update_settings(const json& patch);
    /// Processes a module runs in, as the launcher reports them: its own, and its applications'.
    void set_processes(const std::string& module, std::vector<int> pids);
    [[nodiscard]] std::vector<int> processes(const std::string& module) const;
    /// One daemon asks the others; each that cares, answers in its own time.
    void signal(const std::string& from, const std::string& what);
    /// Evaluate config/daemon-alerts.json's alerts for one daemon's readings.
    void evaluate(const std::string& daemon, const json& readings);
    [[nodiscard]] Daemon* find(const std::string& name) const;

private:
    Host host_;
    json settings_;
    mutable std::mutex settings_mutex_;
    bool enabled_{true};
    Gateway gateway_;
    std::vector<std::unique_ptr<Daemon>> daemons_;
    std::vector<std::jthread> threads_;
    std::mutex wake_mutex_;
    std::condition_variable_any wake_;
    struct Rule {
        json definition;
        Sustained state;
    };
    std::mutex rules_mutex_;
    std::vector<Rule> rules_;
    mutable std::mutex processes_mutex_;
    std::map<std::string, std::vector<int>> processes_;
    std::atomic_bool running_{};
};

/// The settings when the launcher gives none, and what any setting it gives is laid over.
[[nodiscard]] json default_settings();
/// The alerts built in, as config/daemon-alerts.json ships them.
[[nodiscard]] json default_alerts();

// What a process uses, and what the machine has, for the watchers.
struct Usage {
    double cpu_seconds{};
    double resident_bytes{};
};
[[nodiscard]] std::optional<Usage> process_usage(int pid);
[[nodiscard]] std::vector<int> process_group(int group);
struct SystemMemory {
    double total_bytes{}, available_bytes{};
};
[[nodiscard]] std::optional<SystemMemory> system_memory();
[[nodiscard]] std::optional<double> free_disk_bytes(const std::filesystem::path& path);

} // namespace dstns::daemon
