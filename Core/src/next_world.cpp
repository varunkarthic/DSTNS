// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/next_world.hpp"

#include "dstns/geo.hpp"
#include "dstns/osm_fetch.hpp"

#include <cstdlib>
#include <fstream>

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
    if (!enabled() || config.osm_file != "auto") {
        std::lock_guard lock(mutex_);
        state_ = enabled() ? "idle" : "off";
        return;
    }
    const std::filesystem::path cache = config.map_cache_dir;
    const double extent = config.map_city_extent_m;
    const auto here = select_map_location(seed, extent);
    auto prepared = read_pointer(cache);
    // This world was the one prepared: it is used now.
    if (prepared.is_object() && prepared.value("seed", "") == seed.decimal()) {
        std::error_code ec;
        std::filesystem::remove(pointer(cache), ec);
        prepared = nullptr;
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
    const auto record = [this, cache, location, extent, seed = next->decimal()](const std::string& state) {
        write(cache, {{"seed", seed}, {"city", location.city}, {"country", location.country}, {"key", location.cache_key()},
                      {"extent_m", extent}, {"state", state}});
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
    workers_.push_back({seed_, running, std::jthread([this, cache, location, record, seed = seed_, running](std::stop_token) {
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
                // A failure leaves the next world to choose for itself, as it always did.
                if (state == "failed") std::filesystem::remove(pointer(cache), ignored);
                else record(state);
            }
        }
        running->store(false);
    })});
}

std::optional<Seed128> NextWorld::take(const ScenarioConfig& config, const std::string& avoid_city) const {
    if (!enabled() || config.osm_file != "auto") return std::nullopt;
    const auto prepared = read_pointer(config.map_cache_dir);
    if (!prepared.is_object() || prepared.value("extent_m", 0.0) != config.map_city_extent_m) return std::nullopt;
    if (!avoid_city.empty() && prepared.value("city", "") == avoid_city) return std::nullopt;
    try {
        return Seed128::from_decimal(prepared.value("seed", ""));
    } catch (const std::exception&) {
        return std::nullopt;
    }
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
