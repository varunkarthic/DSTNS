// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/daemon.hpp"
#include "dstns/daemon_catalogue.hpp"

#include <algorithm>

namespace dstns::daemon {

std::vector<std::unique_ptr<Daemon>> builtin_daemons();

namespace {
std::int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
// Lay `patch` over `base`, object into object.
void merge(json& base, const json& patch) {
    if (!patch.is_object() || !base.is_object()) {
        base = patch;
        return;
    }
    for (const auto& [key, value] : patch.items()) {
        if (value.is_object() && base.contains(key) && base.at(key).is_object()) merge(base[key], value);
        else base[key] = value;
    }
}
} // namespace

json default_settings() {
    return {
        {"enabled", true},
        {"sustain_s", 5},
        {"daemons", {{"rcs", true}, {"memory", true}, {"disk", true}, {"stall", true}, {"cache", true}}},
        // α, β, γ: the least a module should use while it works, where it is using a lot, the most it ever should.
        {"rcs", {{"modules", {
            {"engine", {{"memory_mib", {4, 2048, 4096}}, {"cpu_percent", {0.2, 180, 380}}}},
            {"downloads", {{"memory_mib", {0, 768, 2048}}, {"cpu_percent", {0, 150, 300}}}},
            {"launcher", {{"memory_mib", {1, 256, 1024}}, {"cpu_percent", {0, 60, 150}}}},
            {"applications", {{"memory_mib", {0, 1024, 4096}}, {"cpu_percent", {0, 200, 400}}}},
        }}}},
        {"cache", {{"interval_s", 600}, {"max_mib", 2048}, {"stale_part_s", 1800}}},
    };
}

json default_alerts() { return json::parse(kAlertsJson); }

void Daemon::set_readings(json readings) {
    std::lock_guard lock(readings_mutex_);
    readings_ = std::move(readings);
}

json Daemon::readings() const {
    std::lock_guard lock(readings_mutex_);
    return readings_;
}

Handler::Handler(Host host, json settings, json alerts) : host_(std::move(host)), settings_(default_settings()) {
    merge(settings_, settings);
    enabled_ = settings_.value("enabled", true);
    gateway_.set_log(host_.log);
    daemons_ = builtin_daemons();
    for (auto& d : daemons_) d->enabled = settings_["daemons"].value(d->name(), true);
    if (alerts.is_object() && alerts.contains("alerts") && alerts.at("alerts").is_array())
        for (const auto& rule : alerts.at("alerts")) rules_.push_back({rule, {}});
}

Handler::~Handler() { stop(); }

json Handler::settings() const {
    std::lock_guard lock(settings_mutex_);
    return settings_;
}

double Handler::sustain_s() const {
    std::lock_guard lock(settings_mutex_);
    return settings_.value("sustain_s", 5.0);
}

void Handler::start() {
    if (!enabled_ || running_.exchange(true)) return;
    for (auto& d : daemons_) {
        Daemon* daemon = d.get();
        threads_.emplace_back([this, daemon](std::stop_token stop) {
            while (!stop.stop_requested()) {
                if (daemon->enabled) {
                    try {
                        daemon->tick(*this);
                    } catch (const std::exception& e) {
                        if (host_.log) host_.log("WARN", daemon->name() + ": " + e.what());
                    }
                    daemon->last_tick_ms = now_ms();
                }
                std::unique_lock lock(wake_mutex_);
                wake_.wait_for(lock, stop, std::chrono::duration<double>(daemon->interval_s()), [] { return false; });
            }
        });
    }
}

void Handler::stop() {
    if (!running_.exchange(false)) return;
    for (auto& t : threads_) t.request_stop();
    wake_.notify_all();
    gateway_.close();
    threads_.clear();
}

Daemon* Handler::find(const std::string& name) const {
    for (const auto& d : daemons_)
        if (d->name() == name) return d.get();
    return nullptr;
}

json Handler::overview() const {
    json daemons = json::array();
    const auto now = now_ms();
    for (const auto& d : daemons_) {
        const auto last = d->last_tick_ms.load();
        daemons.push_back({{"name", d->name()}, {"description", d->description()}, {"enabled", enabled_ && d->enabled.load()},
                           {"running", enabled_ && d->enabled && last > 0 && now - last < static_cast<std::int64_t>(d->interval_s() * 3000 + 2000)}});
    }
    auto& self = const_cast<Handler&>(*this);
    return {{"enabled", enabled_},
            {"daemons", std::move(daemons)},
            {"queues", {{self.gateway_.emergency().name(), self.gateway_.emergency().summary()}, {self.gateway_.notification().name(), self.gateway_.notification().summary()}}},
            {"subscribe", {{"daemonEmergencyQueue", "/api/v1/daemon/emergency-queue"}, {"daemonNotificationQueue", "/api/v1/daemon/notification-queue"}}},
            {"sustain_s", sustain_s()}};
}

std::optional<json> Handler::detail(const std::string& name) const {
    const auto* d = find(name);
    if (!d) return std::nullopt;
    json out = {{"name", d->name()}, {"description", d->description()}, {"enabled", enabled_ && d->enabled.load()}, {"interval_s", d->interval_s()}, {"readings", d->readings()}};
    std::lock_guard lock(settings_mutex_);
    if (settings_.contains(name)) out["settings"] = settings_.at(name);
    return out;
}

bool Handler::set_enabled(const std::string& name, bool on) {
    auto* d = find(name);
    if (!d) return false;
    if (d->enabled.exchange(on) != on) gateway_.publish(on ? "daemon.enabled" : "daemon.disabled", "handler", {{"daemon", name}});
    std::lock_guard lock(settings_mutex_);
    settings_["daemons"][name] = on;
    return true;
}

void Handler::update_settings(const json& patch) {
    std::lock_guard lock(settings_mutex_);
    merge(settings_, patch);
}

void Handler::set_processes(const std::string& module, std::vector<int> pids) {
    std::lock_guard lock(processes_mutex_);
    processes_[module] = std::move(pids);
}

std::vector<int> Handler::processes(const std::string& module) const {
    std::lock_guard lock(processes_mutex_);
    const auto found = processes_.find(module);
    if (found == processes_.end()) return {};
    // Only those still there.
    std::vector<int> alive;
    for (const int pid : found->second)
        if (process_usage(pid)) alive.push_back(pid);
    return alive;
}

void Handler::signal(const std::string& from, const std::string& what) {
    for (auto& d : daemons_) {
        if (d->name() == from || !d->enabled) continue;
        try {
            d->signal(*this, what);
        } catch (const std::exception& e) {
            if (host_.log) host_.log("WARN", d->name() + ": " + e.what());
        }
    }
}

void Handler::evaluate(const std::string& daemon, const json& readings) {
    std::vector<std::string> began;
    {
        std::lock_guard lock(rules_mutex_);
        const double fallback = sustain_s();
        for (auto& rule : rules_) {
            const auto& r = rule.definition;
            if (r.value("daemon", "") != daemon) continue;
            const auto name = r.value("reading", "");
            if (!readings.contains(name) || !readings.at(name).is_number()) continue;
            const double value = readings.at(name).get<double>();
            const bool holds = (r.contains("below") && value < r.at("below").get<double>()) || (r.contains("above") && value > r.at("above").get<double>());
            const auto change = rule.state.update(holds, r.value("sustain_s", fallback));
            if (change == Sustained::Change::Began) {
                gateway_.publish(r.value("message", ""), daemon, readings);
                began.push_back(r.value("message", ""));
            } else if (change == Sustained::Change::Ended && r.contains("recovered")) {
                // Only once nothing about this reading holds: from critical to merely low is not recovered.
                const bool still = std::any_of(rules_.begin(), rules_.end(), [&](const Rule& other) {
                    return &other != &rule && other.definition.value("daemon", "") == daemon && other.definition.value("reading", "") == name && other.state.active();
                });
                if (!still) gateway_.publish(r.at("recovered").get<std::string>(), daemon, readings);
            }
        }
    }
    // What one daemon notices, the others may act on: short of disk, the cache handler clears what it can.
    for (const auto& what : began) signal(daemon, what);
}

} // namespace dstns::daemon
