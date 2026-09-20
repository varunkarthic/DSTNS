#pragma once
#include "dstns/model.hpp"
#include "dstns/demand.hpp"
#include <deque>
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
    [[nodiscard]] double demand_effect(EdgeId edge) const;
    [[nodiscard]] std::vector<std::string> demand_causes(const Scenario& scenario,EdgeId edge) const;

    /**
     * Recompute demand from the network's present condition.
     *
     * The schedule says what a place would do on an ordinary day; this says
     * what it is doing given what has actually happened - roads shut, rain
     * falling, an incident nearby. Called once per tick after edge dynamics
     * are known, so couplings read the same state the operator is shown.
     */
    void recouple(const Scenario& scenario,const std::vector<EdgeDynamic>& edges,std::uint32_t time);

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
    std::priority_queue<ScheduledEvent,std::vector<ScheduledEvent>,std::greater<ScheduledEvent>> queue_;
    std::deque<ScheduledEvent> history_;
    std::vector<int> signal_by_node_;
    using EdgeFeatures = std::vector<std::vector<std::pair<std::uint32_t,double>>>;
    std::shared_ptr<const EdgeFeatures> edge_features_;
    std::vector<double> edge_demand_;

    // Demand model. baseline_ is what the schedule asked for; demand is that
    // after couplings. Both are kept so a figure can be explained.
    std::vector<double> baseline_;
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
    [[nodiscard]] nlohmann::json json() const;
};
}
