#pragma once

#include "dstns/graph.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace dstns {

enum class Lifecycle { Booting, Idle, Preparing, Ready, Running, Paused, Seeking, Stopping, Stopped, Completed, Error, Terminating };
[[nodiscard]] const char* to_string(Lifecycle lifecycle);

struct NewsItem { std::uint64_t news_id{}, event_id{}; std::uint32_t virtual_s{}; std::string category,severity,template_id,message; nlohmann::json data; };
struct AppliedCommand { std::uint64_t id{}; std::string type,status{"applied"}; std::uint32_t virtual_s{}; nlohmann::json before,after; };

class SimulationEngine {
public:
    explicit SimulationEngine(RuntimeLogger& logger);
    ~SimulationEngine();
    SimulationEngine(const SimulationEngine&)=delete;
    SimulationEngine& operator=(const SimulationEngine&)=delete;

    nlohmann::json prepare(Seed128 seed,const ScenarioConfig& config);
    nlohmann::json start(Seed128 seed,const ScenarioConfig& config,std::uint32_t start_virtual_s=0);
    nlohmann::json play(); nlohmann::json pause(); nlohmann::json stop(); nlohmann::json reset();
    nlohmann::json seek(std::uint32_t target_virtual_s,bool resume_after);
    nlohmann::json set_tick_rate(double value); nlohmann::json set_day(int value);
    nlohmann::json set_module(const std::string& module,bool enabled);
    nlohmann::json add_weather(NodeId epicenter,double intensity,double radius_m,std::uint32_t duration_min,double flood_gain);
    nlohmann::json override_edge(EdgeId edge,double speed_multiplier,double capacity_multiplier,bool closed);
    nlohmann::json toggle_signal(NodeId node,std::optional<int> force_phase=std::nullopt);
    nlohmann::json trigger_surge(NodeId node,double factor,double radius_m,std::uint32_t duration_s);
    nlohmann::json validate_transit_route(const std::vector<std::uint32_t>& nodes,const std::string& bus_id,const std::string& label);
    nlohmann::json undo(std::uint32_t count); nlohmann::json redo(std::uint32_t count);

    [[nodiscard]] nlohmann::json status() const; [[nodiscard]] nlohmann::json topology() const;
    [[nodiscard]] nlohmann::json snapshot() const; [[nodiscard]] nlohmann::json nodes(std::size_t offset,std::size_t limit) const;
    [[nodiscard]] nlohmann::json edges(std::size_t offset,std::size_t limit) const; [[nodiscard]] nlohmann::json manifest() const;
    [[nodiscard]] nlohmann::json catalog(const std::string& kind) const;
    [[nodiscard]] nlohmann::json news(std::uint64_t since,std::size_t limit) const; [[nodiscard]] nlohmann::json history() const;
    [[nodiscard]] nlohmann::json global_view() const;
    [[nodiscard]] nlohmann::json export_sumo(const std::filesystem::path& directory) const;
    [[nodiscard]] nlohmann::json sumo_simulate(const std::filesystem::path& directory, std::uint32_t begin_s, std::uint32_t end_s) const;
    [[nodiscard]] std::uint64_t state_revision() const;
    [[nodiscard]] Lifecycle lifecycle() const;
    void terminate();
private:
    struct Checkpoint { std::uint32_t virtual_s{}; std::vector<NodeDynamic> nodes; std::vector<EdgeDynamic> edges; std::size_t news_size{}; std::uint64_t next_news_id{1}; };
    struct ActiveSurgeZone { std::uint32_t id{}; NodeId node{}; std::uint32_t start_s{}; std::uint32_t end_s{}; double factor{1.8}; double radius_m{300}; std::string label; };
    struct DispatchedBusRecord { std::string bus_id, label; std::vector<std::uint32_t> nodes, route_edges; double total_distance_m{0.0}; };
    void loop(); void transition(Lifecycle next); void step_to(std::uint32_t target); void physics_step(std::uint32_t dt); void capture_checkpoint();
    void restore_to(std::uint32_t target); void anchor_wall_clock(); void add_news(std::uint64_t event_id,std::string category,std::string severity,std::string id,std::string message,nlohmann::json data={});
    [[nodiscard]] nlohmann::json clock_json() const; [[nodiscard]] nlohmann::json envelope(nlohmann::json data) const;
    AppliedCommand& record(std::string type,nlohmann::json before,nlohmann::json after);
    void apply_command(const AppliedCommand& command,bool forward);

    RuntimeLogger& logger_; mutable std::recursive_mutex mutex_; std::condition_variable_any cv_; std::jthread worker_;
    Lifecycle lifecycle_{Lifecycle::Idle}; ScenarioCompiler compiler_; std::unique_ptr<GraphStore> graph_;
    std::string run_id_; std::uint32_t virtual_s_{}; std::uint32_t start_virtual_s_{}; double tick_rate_{1};
    std::chrono::steady_clock::time_point anchor_wall_{}; std::uint32_t anchor_virtual_s_{};
    std::chrono::steady_clock::time_point last_global_dump_{};
    std::vector<DwsEvent> manual_weather_; std::vector<ActiveSurgeZone> active_surges_;
    std::vector<DispatchedBusRecord> active_transit_buses_;
    std::vector<NewsItem> news_; std::vector<AppliedCommand> commands_,redo_;
    std::vector<Checkpoint> checkpoints_; std::uint64_t next_command_id_{1},next_news_id_{1},next_event_id_{1'000'000};
    std::vector<const SignalPlan*> signal_by_node_;
    std::map<std::uint32_t, int> signal_overrides_;
    std::uint64_t config_revision_{}; bool terminate_requested_{};
};

} // namespace dstns
