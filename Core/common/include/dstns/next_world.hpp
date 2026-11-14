// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/geo.hpp"
#include "dstns/model.hpp"
#include "dstns/rng.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace dstns {

// Dynamic Fastboot: while a world runs, the next one's city is fetched in the background, so that a new world, or the
// next start of the server, is ready in seconds. Only the very first start downloads while someone waits.
//
// Which seed comes next is written to next-world.json in the map cache, beside the city it names, so that it outlives
// the server: the launcher starts with it, and the cache sweep keeps its city. Once a prepared world has been used, its
// city is listed as spent, and its extract and everything beside it are removed as soon as a world in another city
// takes over, so that each start is somewhere new and the cache does not fill with places already seen.
// Turned off by DSTNS_DYNAMIC_FASTBOOT=0.
class NextWorld {
public:
    [[nodiscard]] static bool enabled();
    // The pointer file in a map cache.
    [[nodiscard]] static std::filesystem::path pointer(const std::filesystem::path& cache);

    // Where a seed goes under the run's engine and selection policy.
    using Locate = std::function<MapLocation(Seed128)>;
    // The pointer records the selection policy it was prepared under (the manifest's map_selection). A prepared seed is
    // offered only to a run with the same policy and extent; a pointer from before 3.3.0 counts as urban-crfg-v3 over
    // every city.
    [[nodiscard]] static bool matches(const nlohmann::json& pointer, double extent_m, const nlohmann::json& selection);

    // A world was installed: if it was the one prepared, that one is used up; then the one after is prepared.
    void installed(Seed128 seed, const ScenarioConfig& config, const Locate& locate, const nlohmann::json& selection,
                   const std::set<std::string>& avoid = {});
    // The seed a new world for this configuration should take: the one prepared, if its city is here. While that is
    // still on its way, a city already in the cache other than `current_city`, which is sooner; else the one on its way.
    // Never in a city of `avoid` (one that failed, and those this session has shown).
    [[nodiscard]] std::optional<Seed128> take(const ScenarioConfig& config, const Locate& locate, const nlohmann::json& selection,
                                              const std::set<std::string>& avoid = {}, const std::string& current_city = "") const;
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

// A seed for a new world in a city not in `avoid`, if the policy leaves one (a bounded number of draws, which with 181
// cities all but always finds the last one left); otherwise one in a city other than `current`, where there is one;
// otherwise any. Returns whether it had to give up on `avoid`.
std::pair<Seed128, bool> seed_avoiding(const std::set<std::string>& avoid, const std::string& current, const NextWorld::Locate& locate);

} // namespace dstns
