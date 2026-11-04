// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The daemons' rules: a condition counts only once it has held for its sustain time, a template is filled in from its
// data, the alerts in config/daemon-alerts.json raise and clear as they should, and the queues keep their order.
#include "dstns/daemon.hpp"

#include <algorithm>
#include <iostream>
#include <string>

using namespace dstns::daemon;
using namespace std::chrono_literals;

namespace {
int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    } else {
        std::cout << "  ok  " << message << '\n';
    }
}
} // namespace

int main() {
    // A spike is not an alarm.
    {
        Sustained s;
        const auto t = std::chrono::steady_clock::now();
        check(s.update(true, 5, t) == Sustained::Change::None, "a condition that has only begun says nothing");
        check(s.update(false, 5, t + 2s) == Sustained::Change::None, "and gone again within its sustain time, nothing ever");
        check(s.update(true, 5, t + 3s) == Sustained::Change::None, "begun again");
        check(s.update(true, 5, t + 8s) == Sustained::Change::Began && s.active(), "held for its sustain time, it counts, once");
        check(s.update(true, 5, t + 9s) == Sustained::Change::None, "and not again while it holds");
        check(s.update(false, 5, t + 10s) == Sustained::Change::None, "gone, it has to stay gone as long too");
        check(s.update(false, 5, t + 15s) == Sustained::Change::Ended && !s.active(), "and then it has ended");
        check(Sustained{}.update(true, 0, t) == Sustained::Change::Began, "with no sustain time, at once");
    }
    // Templates.
    check(fill("{module} uses {value} {unit}", {{"module", "engine"}, {"value", 2048.4}, {"unit", "MiB"}}) == "engine uses 2048 MiB", "a template is filled in, large numbers whole");
    check(fill("{value} and {missing}", {{"value", 3.14159}}) == "3.1 and {missing}", "small ones to a tenth, and what it has no value for left as it is");
    // Every alert names a template that exists, and every template a level.
    {
        Gateway gateway;
        const auto& messages = gateway.templates().at("messages");
        const auto alerts = default_alerts();
        for (const auto& alert : alerts.at("alerts")) {
            check(messages.contains(alert.at("message").get<std::string>()), alert.at("message").get<std::string>() + " is a template");
            if (alert.contains("recovered")) check(messages.contains(alert.at("recovered").get<std::string>()), alert.at("recovered").get<std::string>() + " is a template");
        }
        bool levels = true;
        for (const auto& [id, m] : messages.items()) {
            const auto level = m.value("level", "");
            levels = levels && (level == "info" || level == "warning" || level == "alert" || level == "emergency");
        }
        check(levels, "every template's level is one of info, warning, alert, emergency");
        // Urgent ones go to the emergency queue; the rest are news.
        gateway.publish("memory.critical", "memory", {{"available_mib", 100}, {"total_mib", 16384}, {"available_percent", 0.6}});
        gateway.publish("cache.swept", "cache", {{"removed", 2}, {"freed_mib", 40.5}, {"cache_mib", 900}});
        const auto urgent = gateway.emergency().read(0, 10, 0, "");
        const auto news = gateway.notification().read(0, 10, 0, "");
        check(urgent.at("items").size() == 1 && urgent.at("items")[0].at("id") == "memory.critical", "an emergency goes to daemonEmergencyQueue");
        check(news.at("items").size() == 1 && news.at("items")[0].at("id") == "cache.swept", "what is not urgent goes to daemonNotificationQueue");
        check(news.at("items")[0].at("text") == "2 files, 40.5 MiB, that nothing needed any more. The map cache is 900 MiB.", "with its text filled in");
    }
    // The alerts, as a daemon's readings cross their lines: low, then critical, then back; and only one recovered.
    {
        Host host{.lifecycle = [] { return std::string("IDLE"); }, .virtual_seconds = [] { return std::optional<double>{}; }, .download_groups = [] { return std::vector<int>{}; },
                  .keep = [] { return std::vector<std::filesystem::path>{}; }, .map_cache = {}, .logs = {}, .log = {}};
        // The shipped alerts, each with no sustain time, so that each reading counts at once.
        auto immediate = default_alerts();
        for (auto& alert : immediate["alerts"]) alert["sustain_s"] = 0;
        Handler handler(host, {{"sustain_s", 0}}, immediate);
        const auto ids = [&] {
            std::vector<std::string> out;
            for (auto* q : {&handler.gateway().notification(), &handler.gateway().emergency()}) {
                const auto read = q->read(0, 100, 0, "");
                for (const auto& m : read.at("items")) out.push_back(m.at("id"));
            }
            std::sort(out.begin(), out.end());
            return out;
        };
        const json base = {{"total_mib", 16384}, {"available_mib", 8000}};
        auto plenty = base;
        plenty["available_percent"] = 50;
        handler.evaluate("memory", plenty);
        check(ids().empty(), "plenty of memory says nothing");
        auto low = base;
        low["available_percent"] = 10;
        handler.evaluate("memory", low);
        check(ids() == std::vector<std::string>{"memory.low"}, "low memory, a warning");
        auto critical = base;
        critical["available_percent"] = 3;
        handler.evaluate("memory", critical);
        check(ids() == std::vector<std::string>{"memory.critical", "memory.low"}, "critically low, an emergency too");
        handler.evaluate("memory", low);
        check(ids() == std::vector<std::string>{"memory.critical", "memory.low"}, "from critical back to low is not recovered");
        auto fine = base;
        fine["available_percent"] = 40;
        handler.evaluate("memory", fine);
        check(ids() == std::vector<std::string>{"memory.critical", "memory.low", "memory.recovered"}, "and back to plenty, recovered, once");
    }
    if (failures) std::cerr << failures << " daemon check(s) failed\n";
    return failures ? 1 : 0;
}
