// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/next_world.hpp"

#include "dstns/geo.hpp"
#include "dstns/osm_fetch.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <set>

namespace dstns {

namespace {

nlohmann::json read_pointer(const std::filesystem::path& cache) {
    try {
        std::ifstream in(NextWorld::pointer(cache));
        if (in) return nlohmann::json::parse(in);
    } catch (const std::exception&) {
    }
    return nullptr;
}

// The cities of worlds Dynamic Fastboot has used: each is removed once a world in another city has taken over.
std::vector<std::string> spent_of(const nlohmann::json& pointer) {
    std::vector<std::string> out;
    if (pointer.is_object() && pointer.contains("spent") && pointer.at("spent").is_array())
        for (const auto& key : pointer.at("spent")) if (key.is_string()) out.push_back(key.get<std::string>());
    return out;
}

// A city's extract and everything kept beside it: its manifest, a progress sidecar, an interrupted download. The
// world built from it is in memory, and Fast Boot keeps its own copy elsewhere, so nothing is lost that a run needs.
void forget_city(const std::filesystem::path& cache, const std::string& key) {
    std::error_code ec;
    for (const auto* suffix : {".osm.xml", ".osm.manifest.json", ".osm.xml.progress"}) std::filesystem::remove(cache / (key + suffix), ec);
    std::vector<std::filesystem::path> partial;
    for (const auto& entry : std::filesystem::directory_iterator(cache, ec)) {
        const auto name = entry.path().filename().string();
        if (name.starts_with(key + ".osm.xml.") && name.ends_with(".part")) partial.push_back(entry.path());
    }
    for (const auto& file : partial) std::filesystem::remove(file, ec);
}

} // namespace

bool NextWorld::enabled() {
    const char* value = std::getenv("DSTNS_DYNAMIC_FASTBOOT");
    return !value || std::string(value) != "0";
}

std::filesystem::path NextWorld::pointer(const std::filesystem::path& cache) { return cache / "next-world.json"; }

void NextWorld::write(const std::filesystem::path& cache, const nlohmann::json& value) const {
    std::error_code ec;
    std::filesystem::create_directories(cache, ec);
    const auto file = pointer(cache);
    const auto temporary = file.string() + ".tmp";
    std::ofstream(temporary) << value.dump(2) << '\n';
    std::filesystem::rename(temporary, file, ec);
}

void NextWorld::installed(Seed128 seed, const ScenarioConfig& config) {
    // Prepared seeds are resolved by urban-crfg-v3, so another policy would be handed a city it did not choose.
    // ponytail: no Fastboot for other policies yet; the pointer becomes policy-aware in core-ng's release 5.
    if (!enabled() || config.osm_file != "auto" || config.map_selection_version != "urban-crfg-v3") {
        std::lock_guard lock(mutex_);
        state_ = enabled() ? "idle" : "off";
        return;
    }
    const std::filesystem::path cache = config.map_cache_dir;
    const double extent = config.map_city_extent_m;
    const auto here = select_map_location(seed, extent);
    auto prepared = read_pointer(cache);
    // Worlds used before this one are over: their cities go, unless this world is in one of them again.
    std::vector<std::string> spent;
    for (const auto& key : spent_of(prepared)) {
        if (key == here.cache_key()) spent.push_back(key);
        else forget_city(cache, key);
    }
    // This world was the one prepared: it is used now, and its city goes once the next world takes over.
    if (prepared.is_object() && prepared.value("seed", "") == seed.decimal()) {
        std::error_code ec;
        std::filesystem::remove(pointer(cache), ec);
        prepared = nullptr;
        if (std::find(spent.begin(), spent.end(), here.cache_key()) == spent.end()) spent.push_back(here.cache_key());
    }
    // One prepared earlier and not yet used, for this size of city, stands; its city is fetched again if it went.
    std::optional<Seed128> next;
    if (prepared.is_object() && prepared.value("extent_m", 0.0) == extent) {
        try {
            next = Seed128::from_decimal(prepared.value("seed", ""));
        } catch (const std::exception&) {
        }
    }
    if (!next) {
        // Somewhere else: a new world in the same city would be no surprise.
        next = Seed128::secure64();
        for (int tries = 0; tries < 64 && select_map_location(*next, extent).city == here.city; ++tries) next = Seed128::secure64();
    }
    const auto location = select_map_location(*next, extent);
    std::error_code ec;
    const auto file = location.cache_path(cache);
    const bool on_disk = std::filesystem::is_regular_file(file, ec) && std::filesystem::file_size(file, ec) > 0;
    // By value: the worker records too, long after this returns.
    const auto record = [this, cache, location, extent, spent, seed = next->decimal()](const std::string& state) {
        write(cache, {{"seed", seed}, {"city", location.city}, {"country", location.country}, {"key", location.cache_key()},
                      {"extent_m", extent}, {"state", state}, {"spent", spent}});
    };
    record(on_disk ? "ready" : "fetching");
    std::lock_guard lock(mutex_);
    state_ = on_disk ? "ready" : "fetching";
    seed_ = next->decimal();
    city_ = location.city;
    country_ = location.country;
    error_.clear();
    std::erase_if(workers_, [](const Worker& worker) { return !worker.running->load(); });
    if (on_disk) return;
    for (const auto& worker : workers_) {
        if (worker.seed == seed_) return; // Already on its way.
    }
    auto running = std::make_shared<std::atomic<bool>>(true);
    workers_.push_back({seed_, running, std::jthread([this, cache, location, record, spent, seed = seed_, running](std::stop_token) {
        std::string state = "ready", error;
        try {
            const auto tile = acquire_map_tile(location, cache, true);
            // A world that wanted it now is fetching it; that download is the one that counts.
            if (tile.bytes == 0) state = "fetching";
        } catch (const std::exception& failure) {
            state = "failed";
            error = failure.what();
        }
        {
            std::lock_guard held(mutex_);
            if (seed_ == seed) {
                state_ = state;
                error_ = error;
                std::error_code ignored;
                // A failure leaves the next world to choose for itself, as it always did; the used cities still go.
                if (state == "failed") {
                    if (spent.empty()) std::filesystem::remove(pointer(cache), ignored);
                    else write(cache, {{"spent", spent}});
                } else record(state);
            }
        }
        running->store(false);
    })});
}

std::optional<Seed128> NextWorld::take(const ScenarioConfig& config, const std::string& avoid_city, const std::string& current_city) const {
    if (!enabled() || config.osm_file != "auto" || config.map_selection_version != "urban-crfg-v3") return std::nullopt;
    const auto prepared = read_pointer(config.map_cache_dir);
    const std::string on_its_way = prepared.is_object() ? prepared.value("city", "") : "";
    const auto spent = spent_of(prepared);
    std::optional<Seed128> next;
    if (prepared.is_object() && prepared.value("extent_m", 0.0) == config.map_city_extent_m && on_its_way != avoid_city) {
        try {
            next = Seed128::from_decimal(prepared.value("seed", ""));
        } catch (const std::exception&) {
        }
        if (next && prepared.value("state", "") == "ready") return next;
    }
    // Not here yet: a city already in the cache is sooner. The one on its way stays next, for the world after this.
    const std::filesystem::path cache = config.map_cache_dir;
    std::set<std::string> cached;
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator(cache, ec)) {
        const auto name = entry.path().filename().string();
        // A used world's city is on its way out, not a place for the next one.
        const bool used = std::any_of(spent.begin(), spent.end(), [&](const std::string& key) { return name == key + ".osm.xml"; });
        if (entry.path().extension() == ".xml" && entry.file_size(ec) > 0 && !used) cached.insert(name);
    }
    // ponytail: random draws until one lands in a cached city; with 181 cities, 4000 draws all but always find one.
    for (int tries = 0; !cached.empty() && tries < 4000; ++tries) {
        const auto seed = Seed128::secure64();
        const auto location = select_map_location(seed, config.map_city_extent_m);
        if (location.city == avoid_city || location.city == current_city || location.city == on_its_way) continue;
        if (cached.contains(location.cache_path(cache).filename().string())) return seed;
    }
    return next;
}

nlohmann::json NextWorld::status() const {
    std::lock_guard lock(mutex_);
    if (!enabled()) return {{"enabled", false}, {"state", "off"}};
    nlohmann::json out = {{"enabled", true}, {"state", state_}};
    if (!seed_.empty()) out.update({{"seed", seed_}, {"city", city_}, {"country", country_}});
    if (!error_.empty()) out["error"] = error_;
    return out;
}

} // namespace dstns
