// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/model.hpp"

#include <cstdint>
#include <limits>
#include <span>
#include <memory>
#include <vector>

namespace dstns {

class GraphStore {
public:
    explicit GraphStore(Scenario scenario);
    [[nodiscard]] const Scenario& scenario() const { return scenario_; }
    [[nodiscard]] std::span<const NodeStatic> nodes() const { return scenario_.nodes; }
    [[nodiscard]] std::span<const EdgeStatic> edges() const { return scenario_.edges; }
    [[nodiscard]] const NodeStatic& node(NodeId id) const;
    [[nodiscard]] const EdgeStatic& edge(EdgeId id) const;
    [[nodiscard]] NodeDynamic& node_state(NodeId id);
    [[nodiscard]] EdgeDynamic& edge_state(EdgeId id);
    [[nodiscard]] const std::vector<NodeDynamic>& node_states() const { return node_dynamic_; }
    [[nodiscard]] const std::vector<EdgeDynamic>& edge_states() const { return edge_dynamic_; }
    // Unchecked whole-vector access for loops that already walk every id.
    [[nodiscard]] std::vector<NodeDynamic>& node_states_mut() { return node_dynamic_; }
    [[nodiscard]] std::vector<EdgeDynamic>& edge_states_mut() { return edge_dynamic_; }
    [[nodiscard]] std::span<const EdgeId> outgoing(NodeId id) const;
    [[nodiscard]] std::uint64_t state_revision() const { return state_revision_; }
    void commit();
    // commit, for a tick that has already stamped every edge with state_revision() + 1 as it went (core-ng, #23):
    // the same result without another pass over the edges.
    void commit_stamped();
    void reset_dynamic();
    // What an engine derives once from the static world, kept with it for the world's life (core-ng's per-edge
    // constants, #23). The scenario never changes, so neither does this.
    [[nodiscard]] const std::shared_ptr<const void>& derived() const { return derived_; }
    void set_derived(std::shared_ptr<const void> derived) const { derived_ = std::move(derived); }
private:
    mutable std::shared_ptr<const void> derived_;
    Scenario scenario_;
    std::vector<NodeDynamic> node_dynamic_;
    std::vector<EdgeDynamic> edge_dynamic_;
    std::vector<std::vector<EdgeId>> outgoing_;
    std::uint64_t state_revision_{};
};

struct RouteResult { bool found{}; std::uint64_t cost_ms{}; std::vector<EdgeId> edges; };
class RoutePlanner {
public:
    explicit RoutePlanner(const GraphStore& graph) : graph_(graph) {}
    [[nodiscard]] RouteResult route(NodeId source, NodeId destination) const;
private:
    const GraphStore& graph_;
};

[[nodiscard]] double point_distance(const Point& a, const Point& b);
[[nodiscard]] double wendland_c2(double distance_m, double radius_m);
[[nodiscard]] double temporal_beta(std::uint32_t time_ppm, const TimeWindow& window);

} // namespace dstns
