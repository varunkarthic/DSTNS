// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// One physics tick, apart from the engine that runs it: what a tick reads and writes (Context), the weather and
// incident helpers it uses, and core-legacy's own step. core-ng runs its own copy through ScenarioCompiler::Hooks::step,
// so the two can be compared tick for tick (dstns_golden).
#pragma once

#include "dstns/events.hpp"
#include "dstns/graph.hpp"
#include "dstns/model.hpp"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace dstns::physics {

inline constexpr std::uint32_t day_s = 86400, ppm = 1'000'000;

/// A demand surge called up by hand: a bell in time, centred on a node.
struct ActiveSurgeZone { std::uint32_t id{}; NodeId node{}; std::uint32_t start_s{}; std::uint32_t end_s{}; double factor{1.8}; double radius_m{300}; std::string label; };

struct StormAtmosphericState {
    double cur_x_m;
    double cur_y_m;
    double cur_lat;
    double cur_lon;
    double cur_radius_m;
    double cur_intensity;
    double phase;
    bool active;
};
[[nodiscard]] StormAtmosphericState evaluate_storm_state(const DwsEvent& e, std::uint32_t now_ppm, const NodeStatic& epic_node);

struct NewsDraft {
    std::uint64_t event_id; const char* category; const char* severity; const char* template_id;
    std::string message; nlohmann::json data; std::uint32_t at;
};
[[nodiscard]] NewsDraft incident_started(const Incident& inc);
[[nodiscard]] NewsDraft incident_cleared(const Incident& inc);
struct StormTimes { std::uint32_t start, peak, end; };
[[nodiscard]] StormTimes storm_times(const DwsEvent& e);
[[nodiscard]] NewsDraft rain_started(const DwsEvent& e, std::uint32_t start);
[[nodiscard]] NewsDraft rain_peak(const DwsEvent& e, std::uint32_t peak);
[[nodiscard]] NewsDraft rain_ended(const DwsEvent& e, std::uint32_t end);

/// Everything one tick reads and writes. The engine fills it from its own state, under its lock.
struct Context {
    std::uint32_t virtual_s;
    GraphStore& graph;
    EventRuntime& events;
    const std::map<std::uint32_t, int>& signal_overrides;
    const std::vector<DwsEvent>& manual_weather;
    CongestionTracker& congestion;
    const std::vector<ActiveSurgeZone>& active_surges;
    std::function<void(std::uint64_t, std::string, std::string, std::string, std::string, nlohmann::json)> add_news;
};


/// A snapshot of a run's dynamic state, every 900 virtual seconds, for seeking back.
struct Checkpoint {
    std::uint32_t virtual_s{}; std::vector<NodeDynamic> nodes; std::vector<EdgeDynamic> edges; std::size_t news_size{}; std::uint64_t next_news_id{1}; EventRuntime events; CongestionTracker congestion;
    /// core-ng keeps nodes and edges here instead, deflated (lossless); empty for core-legacy's checkpoints.
    std::string packed;
    /// The memory the nodes and edges take, either way.
    [[nodiscard]] std::size_t bytes() const { return nodes.capacity() * sizeof(NodeDynamic) + edges.capacity() * sizeof(EdgeDynamic) + packed.capacity(); }
};

/// What capturing and restoring checkpoints reads and writes.
struct TimelineContext {
    std::uint32_t& virtual_s;
    GraphStore& graph;
    std::vector<Checkpoint>& checkpoints;
    EventRuntime& events;
    CongestionTracker& congestion;
    std::uint64_t& next_news_id;
    std::function<std::size_t()> news_size;
    std::function<void(std::size_t)> truncate_news;
};



} // namespace dstns::physics
