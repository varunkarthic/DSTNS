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
enum class IncidentType { RoadClosure, Accident, Congestion, VehicleBreakdown, HazardSpill };
enum class IncidentLifecycle { Scheduled, Active, Resolved };

struct Point { double x_m{}, y_m{}, lat{}, lon{}; };
struct TimeWindow { std::uint32_t start_ppm{}, end_ppm{}; std::uint8_t rise_power{2}, fall_power{2}; };

struct NodeStatic {
    NodeId id; std::int64_t osm_node_id{}; Point position; std::uint16_t degree{};
    bool bus_stop{}, signal{}; std::optional<BuildingType> building;
    double building_impact{}, building_radius_m{}, flood_susceptibility{}, drainage{};
    std::uint16_t signal_cycle_s{60}, signal_offset_s{0}, signal_green_s{27};
    std::vector<TimeWindow> tmax;
};
struct NodeDynamic { double rainfall{}, flood{}, building_effect{}; std::uint64_t state_revision{}; };

struct EdgeStatic {
    EdgeId id; NodeId from, to; EdgeId reverse_twin; std::int64_t osm_way_id{};
    std::uint32_t segment_index{}; RoadClass road_class{RoadClass::Residential};
    bool source_oneway{}, synthetic_reverse{}; std::uint16_t lanes{1};
    double length_m{}, free_speed_mps{}, base_capacity_vph{}, hotspot_susceptibility{}, flood_susceptibility{};
    std::vector<Point> geometry;
    std::string name;
    std::map<std::string, std::string> tags;
};

[[nodiscard]] constexpr bool is_source_direction_allowed(const EdgeStatic& edge) noexcept {
    return !edge.synthetic_reverse;
}

struct EdgeDynamic {
    double demand_vph{}, effective_capacity_vph{}, effective_speed_mps{};
    double rainfall{}, flood{}, congestion_model{}, congestion_observed{}, congestion{};
    double signal_multiplier{1}, rain_speed_multiplier{1}, flood_speed_multiplier{1};
    double rain_capacity_multiplier{1}, flood_capacity_multiplier{1};
    double manual_speed_multiplier{1}, manual_capacity_multiplier{1};
    double incident_speed_multiplier{1}, incident_capacity_multiplier{1};
    std::uint32_t vehicle_count{}, halting_count{}; double vehicle_load{}, mean_speed_mps{}, occupancy{};
    bool manual_closed{}, incident_closed{}, closed{}; std::uint64_t state_revision{};
};
struct BusStop { StopId id; NodeId anchor_node; EdgeId edge; double position_m{}, nearest_stop_distance_m{}; };
struct SignalPlan { NodeId node; std::uint16_t cycle_s{}; std::vector<std::uint16_t> phases_s; std::uint16_t offset_s{}; };
struct DwsEvent { EventId id; NodeId epicenter; std::uint32_t start_ppm{}, end_ppm{}; double intensity{}, radius_m{}, flood_gain{}, recovery{}; };
struct PlannedTrip { std::uint64_t id{}; std::uint32_t depart_virtual_s{}; NodeId from, to; std::vector<EdgeId> route; };

struct Incident {
    std::uint64_t id{};
    IncidentType type{IncidentType::RoadClosure};
    std::string severity{"mid"};
    std::string description;
    EdgeId edge{0};
    NodeId node{0};
    std::uint32_t start_virtual_s{};
    std::uint32_t end_virtual_s{};
    double speed_multiplier{1.0};
    double capacity_multiplier{1.0};
    bool closes_road{false};
    bool closed{false};
};

struct MapFeature {
    std::string id, name, category;
    Point center;
    std::vector<Point> geometry;
    std::map<std::string, std::string> tags;
    bool polygon{};
    std::optional<BuildingType> demand_type;
    NodeId anchor;
};

struct ScenarioConfig {
    std::uint32_t playback_duration_s{60}; double tick_rate{1}; int day{0};
    std::uint32_t grid_width{12}, grid_height{10}, max_nodes{50000};
    std::string osm_file;
    std::string saved_seed_id, map_selection_version{"urban-crfg-v2"};
    // On-demand OSM sourcing: the seed picks a city and an anchor, and a tile of
    // this radius is downloaded into map_cache_dir the first time it is needed.
    double map_tile_radius_m{2000};
    std::string map_cache_dir{"data/maps"};
    std::uint32_t dws_frequency{3}, demand_bin_virtual_s{300};
    double stop_min_spacing_m{300}, stop_target_spacing_m{500}, stop_max_coverage_m{800};
    std::uint32_t min_incidents{4};
    bool traffic{true}, signals{true}, buildings{true}, dws{true}, flooding{true}, news{true}, incidents{true};
};

struct Scenario {
    Seed128 seed; ScenarioConfig config; NodeId root;
    std::vector<NodeStatic> nodes; std::vector<EdgeStatic> edges;
    std::vector<MapFeature> features;
    double projection_lat{}, projection_lon{};
    // Provenance of the road network: which real place this graph was cut from.
    std::string map_city, map_country, map_source_file;
    double map_anchor_lat{}, map_anchor_lon{}, map_tile_radius_m{};
    bool map_downloaded{false};
    std::vector<BusStop> bus_stops; std::vector<SignalPlan> signals;
    std::vector<DwsEvent> dws_events; std::vector<PlannedTrip> trips;
    std::vector<Incident> incidents;
    std::vector<EdgeId> hotspot_edges;
    std::string map_hash, graph_hash, event_hash, scenario_hash;
};

[[nodiscard]] const char* to_string(RoadClass value);
[[nodiscard]] const char* to_string(BuildingType value);
[[nodiscard]] const char* to_string(IncidentType value);

} // namespace dstns
