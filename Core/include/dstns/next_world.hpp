// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/model.hpp"
#include "dstns/rng.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace dstns {

// Dynamic Fastboot: while a world runs, the next one's city is fetched in the background, so that a new world, or the
// next start of the server, is ready in seconds. Only the very first start downloads while someone waits.
//
// Which seed comes next is written to next-world.json in the map cache, beside the city it names, so that it outlives
// the server: the launcher starts with it, and the cache sweep keeps its city. Turned off by DSTNS_DYNAMIC_FASTBOOT=0.
class NextWorld {
public:
    [[nodiscard]] static bool enabled();
    // The pointer file in a map cache.
    [[nodiscard]] static std::filesystem::path pointer(const std::filesystem::path& cache);

    // A world was installed: if it was the one prepared, that one is used up; then the one after is prepared.
    void installed(Seed128 seed, const ScenarioConfig& config);
    // The seed a new world for this configuration should take: the one prepared, if its city is here. While that is
    // still on its way, a city already in the cache other than `current_city`, which is sooner; else the one on its way.
    // Never in `avoid_city`.
    [[nodiscard]] std::optional<Seed128> take(const ScenarioConfig& config, const std::string& avoid_city = "",
                                              const std::string& current_city = "") const;
    // What the next world is, and how far it has got, for /api/v1/world/status.
    [[nodiscard]] nlohmann::json status() const;

private:
    void write(const std::filesystem::path& cache, const nlohmann::json& pointer) const;

    struct Worker {
        std::string seed;
        std::shared_ptr<std::atomic<bool>> running;
        std::jthread thread;
    };
    mutable std::mutex mutex_;
    std::string state_{"idle"}; // idle | fetching | ready | failed | off
    std::string seed_, city_, country_, error_;
    // Never joined while a world is being installed: a download can take minutes. One still fetching a city that is
    // no longer next is set aside, and joined once it has finished.
    std::vector<Worker> workers_;
};

} // namespace dstns
