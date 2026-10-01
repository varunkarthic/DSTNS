// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/graph.hpp"
#include "dstns/events.hpp"
#include "dstns/asb.hpp"
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
    // Accept initial preparation immediately; compilation and map I/O continue
    // on the background world worker and publish through status/map-status.
    nlohmann::json start_async(Seed128 seed,const ScenarioConfig& config,std::uint32_t start_virtual_s=0);
    nlohmann::json play(const nlohmann::json& guard = {}); nlohmann::json pause(const nlohmann::json& guard = {}); nlohmann::json stop(); nlohmann::json reset();
    nlohmann::json seek(std::uint32_t target_virtual_s,bool resume_after);
    // Advance exactly `seconds` of virtual time and leave the run paused, so an
    // operator can inspect one increment at a time. Clamped at 24:00.
    nlohmann::json step(std::uint32_t seconds);
    // Replace the active world with one derived from a fresh secure seed and the
    // current run's configuration. The new world is compiled (and its map
    // downloaded) without holding the engine lock, so the current world keeps
    // running and is left untouched if generation fails. Returns immediately;
    // progress is reported by world_status().
    nlohmann::json regenerate_world(const nlohmann::json& request = {});
    [[nodiscard]] nlohmann::json world_status() const;
    /// What compilation is doing right now: "selecting", "acquiring",
    /// "building", or "" when nothing is being compiled. Readable while a
    /// compile holds the engine lock, so the interface can report progress
    /// through a blocking preparation.
    [[nodiscard]] std::string preparation_stage() const;
    /// Whether a replacement world is being prepared right now.
    [[nodiscard]] bool world_generating() const { return world_generating_.load(); }
    nlohmann::json set_tick_rate(double value); nlohmann::json set_day(int value);
    nlohmann::json set_module(const std::string& module,bool enabled);
    nlohmann::json add_weather(NodeId epicenter,double intensity,double radius_m,std::uint32_t duration_min,double flood_gain);
    nlohmann::json override_edge(EdgeId edge,double speed_multiplier,double capacity_multiplier,bool closed);
    nlohmann::json toggle_signal(NodeId node,std::optional<int> force_phase=std::nullopt);
    nlohmann::json trigger_surge(NodeId node,double factor,double radius_m,std::uint32_t duration_s);
    nlohmann::json undo(std::uint32_t count); nlohmann::json redo(std::uint32_t count);

    [[nodiscard]] nlohmann::json scheduled_events(bool future,const std::string& category,std::size_t offset,std::size_t limit) const;
    [[nodiscard]] nlohmann::json status() const; [[nodiscard]] nlohmann::json topology() const;
    [[nodiscard]] nlohmann::json snapshot() const; [[nodiscard]] nlohmann::json nodes(std::size_t offset,std::size_t limit) const;
    [[nodiscard]] nlohmann::json edges(std::size_t offset,std::size_t limit) const; [[nodiscard]] nlohmann::json manifest() const;
    [[nodiscard]] nlohmann::json catalog(const std::string& kind) const;

    /**
     * Places, classified and paginated, with their live demand.
     *
     * The topology endpoint returns every mapped feature; this returns the
     * places the demand model actually reasons about, each with its kind, its
     * scheduled baseline, the couplings currently acting on it, and where it
     * sits. `kind` filters to one classified kind ("school", "bus_stop", ...)
     * and an empty string returns all of them.
     */
    [[nodiscard]] nlohmann::json places(const std::string& kind,std::size_t offset,std::size_t limit) const;

    /// The place taxonomy: every kind the classifier can produce, whether it is
    /// modelled, and how many of each this world holds.
    [[nodiscard]] nlohmann::json place_kinds() const;
    [[nodiscard]] nlohmann::json news(std::uint64_t since,std::size_t limit) const; [[nodiscard]] nlohmann::json history() const;
    [[nodiscard]] nlohmann::json global_view() const;
    [[nodiscard]] nlohmann::json export_sumo(const std::filesystem::path& directory) const;
    [[nodiscard]] nlohmann::json sumo_simulate(const std::filesystem::path& directory, std::uint32_t begin_s, std::uint32_t end_s) const;
    // Adaptive Simulation Backpressure. The observer reports how far behind it
    // is; the engine throttles itself to close the gap and publishes what it did.
    nlohmann::json report_backpressure(double virtual_lag_s, double client_frame_s, double since_poll_s);
    [[nodiscard]] nlohmann::json backpressure() const;
    // Record that a payload of this size was served, for the data-rate report.
    void note_delivery(std::size_t bytes);

    [[nodiscard]] std::uint64_t state_revision() const;
    [[nodiscard]] Lifecycle lifecycle() const;
    void terminate();
    /**
     * Ask the core to stop without waiting for the engine lock.
     *
     * Ordinary termination takes the engine mutex, which a scenario compile
     * holds for its whole duration - and a compile that is downloading a city
     * extract holds it for tens of seconds. An operator who has asked to quit
     * should not have to wait out a download, so this sets the flag alone and
     * lets the compile notice it.
     */
    void request_terminate();
    [[nodiscard]] bool terminating() const { return terminate_requested_.load(); }
private:
    struct Checkpoint { std::uint32_t virtual_s{}; std::vector<NodeDynamic> nodes; std::vector<EdgeDynamic> edges; std::size_t news_size{}; std::uint64_t next_news_id{1}; EventRuntime events; CongestionTracker congestion; };
    struct ActiveSurgeZone { std::uint32_t id{}; NodeId node{}; std::uint32_t start_s{}; std::uint32_t end_s{}; double factor{1.8}; double radius_m{300}; std::string label; };
    [[nodiscard]] double asb_now() const;
    [[nodiscard]] nlohmann::json backpressure_json() const;
    void check_playback_guard(const nlohmann::json& guard) const;
    std::uint64_t playback_revision_{}; // Never reset: distinguishes same-seed restarts.
    void loop(); void transition(Lifecycle next); void step_to(std::uint32_t target); void physics_step(std::uint32_t dt); void capture_checkpoint();
    void restore_to(std::uint32_t target); void anchor_wall_clock(); void catch_up_to_wall_clock(); void add_news(std::uint64_t event_id,std::string category,std::string severity,std::string id,std::string message,nlohmann::json data={});
    [[nodiscard]] nlohmann::json clock_json() const; [[nodiscard]] nlohmann::json envelope(nlohmann::json data) const;
    AppliedCommand& record(std::string type,nlohmann::json before,nlohmann::json after);
    [[nodiscard]] nlohmann::json signal_state_json() const;
    void apply_command(const AppliedCommand& command,bool forward);

    RuntimeLogger& logger_; mutable std::recursive_mutex mutex_; std::condition_variable_any cv_; std::jthread worker_;
    Lifecycle lifecycle_{Lifecycle::Idle};
    // Lock-free mirror of lifecycle_, written only by transition().
    std::atomic<Lifecycle> lifecycle_mirror_{Lifecycle::Idle}; ScenarioCompiler compiler_; std::unique_ptr<GraphStore> graph_;
    std::atomic<bool> compiling_{false}; // Concurrent compiles fail without occupying HTTP workers.
    std::uint64_t compile_generation_{}; // Guarded by mutex_; reset/terminate invalidate a pending install.
    std::string preparation_error_;
    std::string run_id_; std::uint32_t virtual_s_{}; std::uint32_t start_virtual_s_{}; double tick_rate_{1};
    std::chrono::steady_clock::time_point anchor_wall_{}; std::uint32_t anchor_virtual_s_{};
    std::chrono::steady_clock::time_point last_global_dump_{};
    std::vector<DwsEvent> manual_weather_; std::vector<ActiveSurgeZone> active_surges_;
    std::vector<NewsItem> news_; std::vector<AppliedCommand> commands_,redo_;
    std::vector<Checkpoint> checkpoints_; std::uint64_t next_command_id_{1},next_news_id_{1},next_event_id_{1'000'000};
    EventRuntime events_;
    mutable AdaptiveBackpressure asb_;
    double requested_tick_rate_{1.0};
    std::chrono::steady_clock::time_point asb_epoch_{std::chrono::steady_clock::now()};
    CongestionTracker congestion_;
    std::vector<const SignalPlan*> signal_by_node_;
    std::map<std::uint32_t, int> signal_overrides_;
    std::uint64_t config_revision_{};
    // Read without the lock by request_terminate() and by long-running compiles.
    std::atomic<bool> terminate_requested_{false};

    // Shared by start() and world regeneration: adopt a compiled scenario as
    // the active world. Caller holds mutex_.
    void install_scenario(Scenario scenario, double tick_rate, std::uint32_t start_virtual_s);

    // World regeneration job. Guarded by world_mutex_, never by mutex_, so its
    // status stays readable while the engine is busy installing a world.
    struct WorldJob {
        std::string state{"idle"};   // idle | generating | ready | failed
        std::string stage{"idle"};   // seed | compiling | installing | ready | failed
        // `seed` is the operator-facing decimal form; `seed_hex` the internal one.
        std::string seed, seed_hex, previous_run_id, run_id, error_code, error;
        std::uint64_t generation{};
        std::chrono::steady_clock::time_point started{}, finished{};
    };
    mutable std::mutex world_mutex_;
    WorldJob world_job_;
    std::uint64_t world_generation_counter_{};
    // True from the moment a world is requested until the replacement is
    // installed or the attempt fails. Read without world_mutex_ by the
    // backpressure path, which must not block on a generation.
    std::atomic<bool> world_generating_{false};
    // 0 none, 1 selecting, 2 acquiring, 3 building. Atomic because it is read
    // by the API thread while the engine lock is held by a compile.
    std::atomic<int> preparing_stage_{0};
    ScenarioCompiler::Progress compile_progress();
    // When the current world was installed. A report that arrives just after a
    // swap was measured against the world that has just gone.
    std::chrono::steady_clock::time_point installed_at_{};
    [[nodiscard]] nlohmann::json world_status_locked() const;
    // Declared last so it is joined before anything it touches is destroyed.
    std::jthread world_worker_;
};

} // namespace dstns
