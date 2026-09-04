#pragma once

#include "dstns/rng.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace dstns {

template<class Tag, class Rep = std::uint32_t>
struct StrongId {
    Rep value{};
    auto operator<=>(const StrongId&) const = default;
};
struct NodeTag; struct EdgeTag; struct StopTag; struct EventTag;
using NodeId = StrongId<NodeTag>;
using EdgeId = StrongId<EdgeTag>;
using StopId = StrongId<StopTag>;
using EventId = StrongId<EventTag, std::uint64_t>;

enum class RoadClass { Motorway, Primary, Secondary, Tertiary, Residential, Service };
enum class BuildingType { School, Office, Mall, Store };

struct Point { double x_m{}, y_m{}, lat{}, lon{}; };
struct TimeWindow { std::uint32_t start_ppm{}, end_ppm{}; std::uint8_t rise_power{2}, fall_power{2}; };

struct NodeStatic {
    NodeId id; std::int64_t osm_node_id{}; Point position; std::uint16_t degree{};
    bool bus_stop{}, signal{}; std::optional<BuildingType> building;
    double building_impact{}, building_radius_m{}, flood_susceptibility{}, drainage{};
    std::vector<TimeWindow> tmax;
};
struct NodeDynamic { double rainfall{}, flood{}, building_effect{}; std::uint64_t state_revision{}; };

struct EdgeStatic {
    EdgeId id; NodeId from, to; EdgeId reverse_twin; std::int64_t osm_way_id{};
    std::uint32_t segment_index{}; RoadClass road_class{RoadClass::Residential};
    bool source_oneway{}, synthetic_reverse{}; std::uint16_t lanes{1};
    double length_m{}, free_speed_mps{}, base_capacity_vph{}, hotspot_susceptibility{}, flood_susceptibility{};
    std::vector<Point> geometry;
};
struct EdgeDynamic {
    double demand_vph{}, effective_capacity_vph{}, effective_speed_mps{};
    double rainfall{}, flood{}, congestion_model{}, congestion_observed{}, congestion{};
    double signal_multiplier{1}, rain_speed_multiplier{1}, flood_speed_multiplier{1};
    double rain_capacity_multiplier{1}, flood_capacity_multiplier{1};
    double manual_speed_multiplier{1}, manual_capacity_multiplier{1};
    std::uint32_t vehicle_count{}, halting_count{}; double mean_speed_mps{}, occupancy{};
    bool manual_closed{}, closed{}; std::uint64_t state_revision{};
};
struct BusStop { StopId id; NodeId anchor_node; EdgeId edge; double position_m{}, nearest_stop_distance_m{}; };
struct SignalPlan { NodeId node; std::uint16_t cycle_s{}; std::vector<std::uint16_t> phases_s; };
struct DwsEvent { EventId id; NodeId epicenter; std::uint32_t start_ppm{}, end_ppm{}; double intensity{}, radius_m{}, flood_gain{}, recovery{}; };
struct PlannedTrip { std::uint64_t id{}; std::uint32_t depart_virtual_s{}; NodeId from, to; std::vector<EdgeId> route; };

struct ScenarioConfig {
    std::uint32_t playback_duration_s{60}; double tick_rate{1}; int day{-1};
    std::uint32_t grid_width{12}, grid_height{10}, max_nodes{50000};
    std::string osm_file;
    std::uint32_t dws_frequency{3}, demand_bin_virtual_s{300};
    double stop_min_spacing_m{300}, stop_target_spacing_m{500}, stop_max_coverage_m{800};
    bool traffic{true}, signals{true}, buildings{true}, dws{true}, flooding{true}, news{true};
};

struct Scenario {
    Seed128 seed; ScenarioConfig config; NodeId root;
    std::vector<NodeStatic> nodes; std::vector<EdgeStatic> edges;
    std::vector<BusStop> bus_stops; std::vector<SignalPlan> signals;
    std::vector<DwsEvent> dws_events; std::vector<PlannedTrip> trips;
    std::vector<EdgeId> hotspot_edges;
    std::string map_hash, graph_hash, event_hash, scenario_hash;
};

[[nodiscard]] const char* to_string(RoadClass value);
[[nodiscard]] const char* to_string(BuildingType value);

} // namespace dstns
