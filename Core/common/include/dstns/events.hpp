// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once
#include "dstns/model.hpp"
#include "dstns/demand.hpp"
#include <deque>
#include <algorithm>
#include <queue>
#include <memory>
#include <tuple>
#include <nlohmann/json.hpp>

namespace dstns {
struct ScheduledEvent {
    std::uint32_t time{}, entity{}, phase{};
    std::uint64_t sequence{};
    std::string category, description;
    double value{};
    bool operator>(const ScheduledEvent& b) const { return std::tie(time,sequence)>std::tie(b.time,b.sequence); }
};
struct SignalState { std::uint32_t phase{}, next_transition{}; std::int64_t phase_started{}; };
// One pending transition per signal. Heap insert/pop O(log n), peek O(1).
// History is a bounded observation window; executed_count records all executions.
class EventRuntime {
public:
    void initialize(const Scenario& scenario);
    void observe(ScheduledEvent event);
    std::vector<ScheduledEvent> advance(const Scenario& scenario,std::uint32_t time);
    [[nodiscard]] nlohmann::json inspect(bool future,const std::string& category,std::size_t offset,std::size_t limit) const;
    [[nodiscard]] nlohmann::json signal_json(const Scenario& scenario,std::uint32_t time) const;
    [[nodiscard]] nlohmann::json demand_json(const Scenario& scenario) const;
    [[nodiscard]] double signal_multiplier(const Scenario& scenario,const EdgeStatic& edge) const;
    // signal_multiplier in parts, for a caller that walks the edges itself (core-ng's tick, #23): each edge's signal
    // group (-1 none, 0 B, 1 A), or null when no edge has one; each node's signal phase, read once per tick; and the
    // multiplier a group and phase give. signal_value(group, phases[edge.to]) is signal_multiplier(edge) exactly.
    [[nodiscard]] const std::vector<std::int8_t>* edge_signal_groups() const { return edge_signal_group_.get(); }
    void signal_phases(std::vector<std::uint32_t>& per_node) const;
    [[nodiscard]] static double signal_value(std::int8_t group,std::uint32_t phase) {
        if(group<0)return 1;
        const bool group_a=group==1;
        if((group_a&&phase==0)||(!group_a&&phase==3))return 1;
        if((group_a&&phase==1)||(!group_a&&phase==4))return .4;
        return .08;
    }
    [[nodiscard]] double demand_effect(EdgeId edge) const { return edge_demand_[edge.value]; }
    // The places adding demand to this road, in the order they are recorded; at most `limit` of them, if it is not 0.
    [[nodiscard]] std::vector<std::string> demand_causes(const Scenario& scenario,EdgeId edge,std::size_t limit=0) const;

    /**
     * Recompute demand from the network's present condition.
     *
     * The schedule says what a place would do on an ordinary day; this says
     * what it is doing given what has actually happened - roads shut, rain
     * falling, an incident nearby. Called once per tick after edge dynamics
     * are known, so couplings read the same state the operator is shown.
     */
    void recouple(const Scenario& scenario,const std::vector<EdgeDynamic>& edges,std::uint32_t time);
    // recouple in two halves, for a caller that walks the edges itself (core-ng's tick, #23): whether couplings are
    // recomputed at all; one edge noted after its tick (true if its availability changed); then the rest, told
    // whether any edge's availability changed and whether anything is disturbed.
    [[nodiscard]] bool coupling(const Scenario& scenario) const;
    bool note_edge(std::size_t edge,const EdgeDynamic& dynamic) {
        const bool available=(*edge_allowed_)[edge]&&!dynamic.closed&&!dynamic.incident_closed;
        const bool changed=edge_available_[edge]!=available;
        edge_available_[edge]=available;
        return changed;
    }
    // An edge with rain, flood or a closure this tick. When the caller notes them all, only the places near one are
    // read again: every other place reads all zeros, what its context starts as, so the result is the same.
    void note_disturbed(std::uint32_t edge) { disturbed_edges_.push_back(edge); }
    void recouple_noted(const Scenario& scenario,const std::vector<EdgeDynamic>& edges,std::uint32_t time,bool network_changed,bool disturbed);

    /// Why a place's demand is what it is, newest contribution first.
    [[nodiscard]] std::vector<DemandFactor> demand_factors(std::size_t feature) const;
    /// Classified kind of each feature, in feature order.
    [[nodiscard]] const std::vector<PlaceKind>& place_kinds() const { return kinds_; }
    /// The unmodified schedule value, before couplings.
    [[nodiscard]] double baseline_demand(std::size_t feature) const {
        return feature < baseline_.size() ? baseline_[feature] : 1.0;
    }

    std::vector<SignalState> signals;
    /// Effective demand per feature: schedule multiplied by live couplings.
    std::vector<double> demand;
    std::uint64_t executed_count{};
private:
    void push(ScheduledEvent event);
    std::uint64_t next_sequence_{1};
    // The schedule, earliest first by (time, sequence). The heap holds only those and a slot, and the events wait in
    // the slots, so a heap step moves 24 bytes instead of an event and its strings (#23). Sequences are unique, so
    // the order is the one a priority_queue of whole events gives.
    struct Queue {
        struct Key {
            std::uint32_t time;
            std::uint32_t slot;
            std::uint64_t sequence;
            bool operator>(const Key& b) const { return std::tie(time,sequence)>std::tie(b.time,b.sequence); }
        };
        std::vector<Key> heap;
        std::vector<ScheduledEvent> slots;
        std::vector<std::uint32_t> unused;
        [[nodiscard]] bool empty() const { return heap.empty(); }
        [[nodiscard]] std::size_t size() const { return heap.size(); }
        [[nodiscard]] const ScheduledEvent& top() const { return slots[heap.front().slot]; }
        void push(ScheduledEvent e) {
            std::uint32_t slot;
            if(unused.empty()){slot=static_cast<std::uint32_t>(slots.size());slots.push_back(std::move(e));}
            else{slot=unused.back();unused.pop_back();slots[slot]=std::move(e);}
            heap.push_back({slots[slot].time,slot,slots[slot].sequence});
            std::push_heap(heap.begin(),heap.end(),std::greater<Key>{});
        }
        ScheduledEvent take() {
            std::pop_heap(heap.begin(),heap.end(),std::greater<Key>{});
            const auto slot=heap.back().slot;
            heap.pop_back();
            unused.push_back(slot);
            return std::move(slots[slot]);
        }
    };
    Queue queue_;
    std::deque<ScheduledEvent> history_;
    std::vector<int> signal_by_node_;
    // Per edge, fixed for the world: which signal group its approach belongs
    // to (-1 none, 0 B, 1 A) and whether its direction is traversable. Shared,
    // not copied, by checkpoints.
    std::shared_ptr<const std::vector<std::int8_t>> edge_signal_group_;
    std::shared_ptr<const std::vector<std::uint8_t>> edge_allowed_;
    using EdgeFeatures = std::vector<std::vector<std::pair<std::uint32_t,double>>>;
    std::shared_ptr<const EdgeFeatures> edge_features_;
    std::vector<double> edge_demand_;
    std::vector<std::vector<std::pair<std::uint32_t,double>>> delivery_;
    void rebuild_delivery();

    // Demand model. baseline_ is what the schedule asked for; demand is that
    // after couplings. Both are kept so a figure can be explained.
    std::vector<double> baseline_, scheduled_baseline_;
    std::vector<bool> edge_available_;
    std::vector<std::uint32_t> disturbed_edges_;  // empty between ticks, so checkpoints carry nothing
    std::vector<NodeId> feature_origins_;
    std::vector<std::pair<NodeId, NodeId>> edge_endpoints_;
    std::vector<PlaceKind> kinds_;
    // Inverse of edge_features_: which edges each place draws from, and which
    // other places are close enough to influence it.
    using FeatureEdges = std::vector<std::vector<std::pair<std::uint32_t,double>>>;
    std::shared_ptr<const FeatureEdges> feature_edges_;
    std::shared_ptr<const std::vector<std::vector<std::uint32_t>>> feature_peers_;
    std::vector<std::vector<DemandFactor>> factors_;
    // Features the demand model has anything to say about. Everything else sits
    // at 1.0 for the whole run, so a tick never walks it.
    std::vector<std::uint32_t> responders_;
    void rebuild_edge_demand();
};
struct CongestionSample { std::uint32_t time{}; double current{}, average{}; };
struct CongestionTracker {
    double current{}, average{};
    std::vector<CongestionSample> samples;
    void update(const Scenario& scenario,const std::vector<EdgeDynamic>& edges,std::uint32_t time,std::uint32_t dt);
    // The same, from the length-and-lane-weighted sum of congestion and the weights, summed in the edges' order by
    // a caller that has them already (core-ng's tick, #23).
    void record(double sum,double weights,std::uint32_t time,std::uint32_t dt);
    [[nodiscard]] nlohmann::json json() const;
};
}
