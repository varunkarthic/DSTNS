// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The daemons that come with DSTNS. Each wakes, reads what it watches, publishes its readings, and says something only
// once a condition has held for its sustain time.

#include "dstns/daemon.hpp"

#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <fstream>

namespace dstns::daemon {

namespace {

using clock = std::chrono::steady_clock;

double mib(double bytes) { return std::round(bytes / 1048576.0 * 10) / 10; }
std::int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------------------------------------------------
// The Resource Control Subsystem. For each module and each of memory and processor there are three lines:
//   α the least it should use while it works (below it, something may be wrong: the lowest kind of message)
//   β where it is using a lot (a warning)
//   γ the most it should ever use (an alert, on daemonEmergencyQueue)
class Rcs final : public Daemon {
public:
    std::string name() const override { return "rcs"; }
    std::string description() const override { return "Resource Control Subsystem: each module's memory and processor against its α, β and γ"; }

    void tick(Handler& handler) override {
        const json modules = handler.settings().value("rcs", json::object()).value("modules", json::object());
        const auto now = clock::now();
        json readings = json::object();
        for (const auto& [module, limits] : modules.items()) {
            const auto pids = members(handler, module);
            double resident = 0, cpu = 0;
            bool measured = false;
            for (const int pid : pids) {
                const auto usage = process_usage(pid);
                if (!usage) continue;
                resident += usage->resident_bytes;
                // A share of one core, from how much processor time it used since it was last seen.
                if (const auto seen = last_.find(pid); seen != last_.end()) {
                    const double wall = std::chrono::duration<double>(now - seen->second.second).count();
                    if (wall > 0) {
                        cpu += std::max(0.0, usage->cpu_seconds - seen->second.first) / wall * 100;
                        measured = true;
                    }
                }
                last_[pid] = {usage->cpu_seconds, now};
            }
            json entry = {{"pids", pids}, {"memory_mib", mib(resident)}, {"cpu_percent", measured ? json(std::round(cpu * 10) / 10) : json(nullptr)}};
            // Nothing running in it: nothing to say about it either.
            if (pids.empty()) {
                zones_.erase(module + "/memory");
                zones_.erase(module + "/processor");
            } else {
                // Using little processor is only odd for a run that is meant to be running.
                const bool working = module != "engine" || handler.host().lifecycle() == "RUNNING";
                entry["zone"] = {{"memory", judge(handler, module, "memory", "MiB", mib(resident), limits.value("memory_mib", json::array()), true, now)},
                                 {"processor", measured ? judge(handler, module, "processor", "%", std::round(cpu * 10) / 10, limits.value("cpu_percent", json::array()), working, now) : "measuring"}};
            }
            entry["limits"] = limits;
            readings[module] = std::move(entry);
        }
        // Forget processes that are gone.
        std::erase_if(last_, [&](const auto& item) { return now - item.second.second > std::chrono::seconds(10); });
        set_readings(std::move(readings));
    }

private:
    std::vector<int> members(Handler& handler, const std::string& module) {
        if (module == "engine") return {static_cast<int>(getpid())};
        if (module == "downloads") {
            std::vector<int> out;
            for (const int group : handler.host().download_groups()) {
                auto members = process_group(group);
                out.insert(out.end(), members.begin(), members.end());
            }
            return out;
        }
        return handler.processes(module);
    }

    struct Zone {
        std::string reported{"normal"}, candidate{"normal"};
        clock::time_point since{};
    };

    std::string judge(Handler& handler, const std::string& module, const std::string& metric, const std::string& unit, double value, const json& lines, bool working,
                      clock::time_point now) {
        if (!lines.is_array() || lines.size() != 3) return "unlimited";
        const double alpha = lines[0].get<double>(), beta = lines[1].get<double>(), gamma = lines[2].get<double>();
        const std::string zone = value >= gamma ? "gamma" : value >= beta ? "beta" : working && value < alpha ? "alpha" : "normal";
        auto& z = zones_[module + "/" + metric];
        if (zone != z.candidate) {
            z.candidate = zone;
            z.since = now;
        }
        const double sustain = handler.sustain_s();
        if (z.candidate != z.reported && std::chrono::duration<double>(now - z.since).count() >= sustain) {
            const json data = {{"module", module}, {"metric", metric}, {"unit", unit}, {"value", value}, {"alpha", alpha}, {"beta", beta}, {"gamma", gamma}, {"sustain_s", sustain}};
            if (z.candidate == "gamma") handler.gateway().publish("rcs.over_gamma", name(), data);
            else if (z.candidate == "beta") handler.gateway().publish("rcs.over_beta", name(), data);
            else if (z.candidate == "alpha") handler.gateway().publish("rcs.below_alpha", name(), data);
            else if (z.reported == "beta" || z.reported == "gamma") handler.gateway().publish("rcs.recovered", name(), data);
            z.reported = z.candidate;
        }
        return z.reported;
    }

    std::map<int, std::pair<double, clock::time_point>> last_;
    std::map<std::string, Zone> zones_;
};

// ---------------------------------------------------------------------------------------------------------------------
class Memory final : public Daemon {
public:
    std::string name() const override { return "memory"; }
    std::string description() const override { return "The machine's memory: how much is left, before anything has to be stopped"; }
    double interval_s() const override { return 2.0; }
    void tick(Handler& handler) override {
        const auto memory = system_memory();
        if (!memory || memory->total_bytes <= 0) return;
        const json readings = {{"total_mib", mib(memory->total_bytes)}, {"available_mib", mib(memory->available_bytes)},
                               {"available_percent", std::round(memory->available_bytes / memory->total_bytes * 1000) / 10}};
        set_readings(readings);
        handler.evaluate(name(), readings);
    }
};

class Disk final : public Daemon {
public:
    std::string name() const override { return "disk"; }
    std::string description() const override { return "Free space where the logs and the maps are kept"; }
    double interval_s() const override { return 10.0; }
    void tick(Handler& handler) override {
        std::optional<double> least;
        for (const auto& where : {handler.host().logs, handler.host().map_cache}) {
            if (const auto free = free_disk_bytes(where)) least = least ? std::min(*least, *free) : *free;
        }
        if (!least) return;
        const json readings = {{"free_mib", mib(*least)}};
        set_readings(readings);
        handler.evaluate(name(), readings);
    }
};

class Stall final : public Daemon {
public:
    std::string name() const override { return "stall"; }
    std::string description() const override { return "A run meant to be running whose clock has stopped moving"; }
    void tick(Handler& handler) override {
        const auto now = clock::now();
        const auto lifecycle = handler.host().lifecycle();
        if (lifecycle != "RUNNING") {
            moved_ = now;
            last_.reset();
        } else if (const auto at = handler.host().virtual_seconds(); at && (!last_ || *at != *last_)) {
            last_ = at;
            moved_ = now;
        }
        const json readings = {{"lifecycle", lifecycle}, {"stalled_s", std::round(std::chrono::duration<double>(now - moved_).count())}};
        set_readings(readings);
        handler.evaluate(name(), readings);
    }

private:
    std::optional<double> last_;
    clock::time_point moved_{clock::now()};
};

// ---------------------------------------------------------------------------------------------------------------------
// The auto cache handler: the map cache kept within its budget, oldest first, and nothing left that nothing needs.
// It never removes the running world's city, Dynamic Fastboot's next one, or a download that may still be going.
class Cache final : public Daemon {
public:
    std::string name() const override { return "cache"; }
    std::string description() const override { return "Clears what nothing needs any more: old cities beyond the cache's budget, abandoned downloads, stray files"; }
    double interval_s() const override { return 5.0; }

    void tick(Handler& handler) override {
        const auto settings = handler.settings().value("cache", json::object());
        const double every = settings.value("interval_s", 600.0);
        if (clock::now() - last_ < std::chrono::duration<double>(every) && last_ != clock::time_point{}) return;
        sweep(handler);
    }
    void signal(Handler& handler, const std::string& what) override {
        // Short of space: now, but not more than once a minute.
        if ((what == "disk.low" || what == "disk.critical") && clock::now() - last_ > std::chrono::seconds(60)) sweep(handler);
    }

private:
    void sweep(Handler& handler) {
        last_ = clock::now();
        const auto settings = handler.settings().value("cache", json::object());
        const double budget = settings.value("max_mib", 2048.0) * 1048576.0;
        const double stale = settings.value("stale_part_s", 1800.0);
        const auto& directory = handler.host().map_cache;
        std::error_code ec;
        std::set<std::string> keep;
        for (const auto& file : handler.host().keep()) keep.insert(file.filename().string());
        try {
            std::ifstream pointer(directory / "next-world.json");
            if (pointer) keep.insert(json::parse(pointer).value("key", "") + ".osm.xml");
        } catch (const std::exception&) {
        }
        struct Entry {
            std::filesystem::path file;
            std::filesystem::file_time_type written;
            double bytes;
        };
        std::vector<Entry> cities;
        std::vector<std::filesystem::path> remove;
        double total = 0;
        const bool downloading = !handler.host().download_groups().empty();
        const auto now = std::filesystem::file_time_type::clock::now();
        for (const auto& item : std::filesystem::directory_iterator(directory, ec)) {
            if (ec || !item.is_regular_file(ec)) continue;
            const auto path = item.path();
            const auto name = path.filename().string();
            const double bytes = static_cast<double>(item.file_size(ec));
            const auto written = item.last_write_time(ec);
            if (name.ends_with(".osm.xml")) {
                total += bytes;
                if (!keep.contains(name)) cities.push_back({path, written, bytes});
            } else if (path.extension() == ".part" || path.extension() == ".progress") {
                // An abandoned download: old, and nothing downloading that could still be writing it.
                if (!downloading && std::chrono::duration<double>(now - written).count() > stale) remove.push_back(path);
            } else if (name.ends_with(".osm.manifest.json")) {
                const auto extract = path.parent_path() / (name.substr(0, name.size() - std::string(".osm.manifest.json").size()) + ".osm.xml");
                if (!std::filesystem::exists(extract, ec)) remove.push_back(path);
            } else if (path.extension() == ".tmp" && std::chrono::duration<double>(now - written).count() > stale) {
                remove.push_back(path);
            }
        }
        // Over budget: the cities least recently written go first.
        std::sort(cities.begin(), cities.end(), [](const Entry& a, const Entry& b) { return a.written < b.written; });
        for (const auto& city : cities) {
            if (total <= budget) break;
            remove.push_back(city.file);
            remove.push_back(city.file.parent_path() / (city.file.stem().stem().string() + ".osm.manifest.json"));
            total -= city.bytes;
        }
        std::size_t removed = 0;
        double freed = 0;
        for (const auto& path : remove) {
            const double bytes = static_cast<double>(std::filesystem::file_size(path, ec));
            if (!ec && std::filesystem::remove(path, ec)) {
                ++removed;
                freed += bytes;
            }
            ec.clear();
        }
        const json readings = {{"last_sweep_ms", now_ms()}, {"removed", removed}, {"freed_mib", mib(freed)}, {"cache_mib", mib(total)}, {"max_mib", mib(budget)}};
        set_readings(readings);
        if (removed > 0) handler.gateway().publish("cache.swept", name(), readings);
    }

    clock::time_point last_{};
};

} // namespace

std::vector<std::unique_ptr<Daemon>> builtin_daemons() {
    std::vector<std::unique_ptr<Daemon>> out;
    out.push_back(std::make_unique<Rcs>());
    out.push_back(std::make_unique<Memory>());
    out.push_back(std::make_unique<Disk>());
    out.push_back(std::make_unique<Stall>());
    out.push_back(std::make_unique<Cache>());
    return out;
}

} // namespace dstns::daemon
