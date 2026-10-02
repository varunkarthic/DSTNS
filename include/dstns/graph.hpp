// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/model.hpp"

#include <cstdint>
#include <limits>
#include <span>
#include <vector>

namespace dstns {

/// Supplies a graph's dynamic state when something other than the graph owns
/// it. The simulation engine's compute dispatcher holds the authoritative,
/// fixed-point state of a run; the graph keeps a double-precision view of it
/// for readers, rebuilt on demand after each change.
class DynamicStateSource {
public:
    virtual ~DynamicStateSource() = default;
    virtual void materialize(std::vector<NodeDynamic>& nodes, std::vector<EdgeDynamic>& edges, std::uint64_t revision) const = 0;
};

class GraphStore {
public:
    explicit GraphStore(Scenario scenario);
    [[nodiscard]] const Scenario& scenario() const { return scenario_; }
    [[nodiscard]] std::span<const NodeStatic> nodes() const { return scenario_.nodes; }
    [[nodiscard]] std::span<const EdgeStatic> edges() const { return scenario_.edges; }
    [[nodiscard]] const NodeStatic& node(NodeId id) const;
    [[nodiscard]] const EdgeStatic& edge(EdgeId id) const;
    // Mutable access to the dynamic state, for a graph that owns it (tools and
    // tests). A graph whose state comes from a DynamicStateSource refuses:
    // a write here would be overwritten by the next refresh.
    [[nodiscard]] NodeDynamic& node_state(NodeId id);
    [[nodiscard]] EdgeDynamic& edge_state(EdgeId id);
    [[nodiscard]] const std::vector<NodeDynamic>& node_states() const { refresh(); return node_dynamic_; }
    [[nodiscard]] const std::vector<EdgeDynamic>& edge_states() const { refresh(); return edge_dynamic_; }
    [[nodiscard]] std::span<const EdgeId> outgoing(NodeId id) const;
    [[nodiscard]] std::uint64_t state_revision() const { return state_revision_; }
    /// A new state revision: the view is refreshed when next read.
    void commit();
    /// The source's state changed without a new revision (a restored checkpoint).
    void invalidate() { stale_ = source_ != nullptr; }
    /// Back to the state before the first step, revision 0. With a source
    /// attached, the source resets its own state; this resets the revision.
    void reset_dynamic();
    /// Take the dynamic state from `source` from now on; nullptr gives
    /// ownership back to the graph. The source must outlive the graph or be
    /// detached first.
    void attach_dynamic_source(const DynamicStateSource* source);
    [[nodiscard]] bool has_dynamic_source() const { return source_ != nullptr; }
private:
    void refresh() const;
    Scenario scenario_;
    // A cache of the source's state when one is attached. Refreshed inside
    // const readers, which the engine calls only under its own mutex.
    mutable std::vector<NodeDynamic> node_dynamic_;
    mutable std::vector<EdgeDynamic> edge_dynamic_;
    std::vector<std::vector<EdgeId>> outgoing_;
    std::uint64_t state_revision_{};
    const DynamicStateSource* source_{};
    mutable bool stale_{false};
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
