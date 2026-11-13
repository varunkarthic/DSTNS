// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/graph.hpp"
#include "dstns/events.hpp"
#include "dstns/asb.hpp"
#include "dstns/logging.hpp"
#include "dstns/next_world.hpp"
#include "dstns/scenario.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace dstns {

class Narrator;
class NarrationContext;

enum class Lifecycle { Booting, Idle, Preparing, Ready, Running, Paused, Seeking, Stopping, Stopped, Completed, Error, Terminating };
[[nodiscard]] const char* to_string(Lifecycle lifecycle);

// narration_key names the item's narration, if it has one (see narrator.hpp);
// it is presentation only and never part of the run's state.
struct NewsItem { std::uint64_t news_id{}, event_id{}; std::uint32_t virtual_s{}; std::string category,severity,template_id,message; nlohmann::json data; std::string narration_key; };
struct AppliedCommand { std::uint64_t id{}; std::string type,status{"applied"}; std::uint32_t virtual_s{}; nlohmann::json before,after; };

// What an engine is, as every layer reports it: its own version, whether it is a real engine or a pseudo-engine
// that delegates, its release channel, which parts of a run it owns and which it shares, and what changed in this
// version.
struct EngineIdentity {
    std::string version;
    std::string kind{"real"};      // real or pseudo
    std::string channel{"stable"}; // alpha, beta or stable
    std::vector<std::string> owns, shared, changes;
    [[nodiscard]] nlohmann::json to_json(const std::string& id) const {
        return {{"id", id}, {"version", version}, {"kind", kind}, {"channel", channel}, {"owns", owns}, {"shared", shared}, {"changes", changes}};
    }
};

class SimulationEngine {
public:
    explicit SimulationEngine(RuntimeLogger& logger);
    ~SimulationEngine();
    SimulationEngine(const SimulationEngine&)=delete;
    SimulationEngine& operator=(const SimulationEngine&)=delete;

    // Make another engine available by name, with the hooks that route compilation through it. Call before the
    // API serves requests; the set is read without the lock afterwards. "core-legacy" is always available.
    void register_engine(const std::string& id, ScenarioCompiler::Hooks hooks, EngineIdentity identity = {});
    // What an engine is (core-legacy's identity is set by the server, which knows the build's version).
    void set_identity(const std::string& id, EngineIdentity identity);
    [[nodiscard]] std::vector<std::string> engines() const;
    [[nodiscard]] nlohmann::json identity(const std::string& id) const;
    [[nodiscard]] nlohmann::json catalogue() const;
    // Refuses an engine this server does not have, or a policy it cannot run, before anything starts.
    void check_engine(const ScenarioConfig& config) const { require_engine(config); }
    // Checks every lifecycle transition. One it refuses is still made, so a run is never wedged, but it is logged as an
    // error and counted. Set before the API serves requests.
    void set_transition_guard(std::function<bool(Lifecycle, Lifecycle)> guard);
    // The same for the world-generation job's states (idle, generating, staged, ready, failed).
    void set_world_guard(std::function<bool(const std::string&, const std::string&)> guard);
    [[nodiscard]] std::uint64_t illegal_transitions() const { return illegal_transitions_.load(); }
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
    // A world prepared with {"stage": true}: put in now (or as soon as it is ready), or forgotten.
    nlohmann::json commit_world();
    nlohmann::json discard_world();
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
    [[nodiscard]] nlohmann::json snapshot() const;
    // The same snapshot as JSON text, written directly rather than built as a document first, which is most of what
    // a snapshot costs. `causes` above 0 lists at most that many demand causes per road, which are most of its bytes,
    // for a client that shows only the first few; 0 lists them all.
    [[nodiscard]] std::string snapshot_text(std::size_t causes = 0) const;
    [[nodiscard]] nlohmann::json nodes(std::size_t offset,std::size_t limit) const;
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
    /// What a bus stop at each node would see now, by the model real stops use: the
    /// hour's profile, pulled up by trip generators nearby. Read-only.
    [[nodiscard]] nlohmann::json stop_demand(const std::vector<std::uint32_t>& nodes) const;
    /// Why these overlay features cannot be placed on the loaded network; empty if they can.
    [[nodiscard]] std::string network_problem(const nlohmann::json& features) const;

    /// The place taxonomy: every kind the classifier can produce, whether it is
    /// modelled, and how many of each this world holds.
    [[nodiscard]] nlohmann::json place_kinds() const;
    /**
     * News after `since`. With `realistic` (the observer's Realistic News
     * setting; ?narration=realistic over HTTP) items carry their narrative,
     * and items narrated since completion sequence `since_narration` are
     * listed under "narrated". Without it the feed is exactly the core's.
     */
    [[nodiscard]] nlohmann::json news(std::uint64_t since,std::size_t limit,std::uint64_t since_narration=0,bool realistic=false) const; [[nodiscard]] nlohmann::json history() const;
    /**
     * The topology response, serialized. A world's topology never changes, so
     * its body is built once per world and only the envelope (clock, revision)
     * is composed per request, instead of rebuilding megabytes of JSON under
     * the engine lock every time an observer connects.
     */
    [[nodiscard]] std::string topology_text() const;

    /**
     * Attach a narrator: news items it can word are handed to it, and their
     * narrations, once written, are served beside the core's text. Optional;
     * the simulation never reads anything back from it.
     */
    void set_narrator(std::shared_ptr<Narrator> narrator);
    [[nodiscard]] nlohmann::json narrator_status() const;
    [[nodiscard]] nlohmann::json global_view() const;
    [[nodiscard]] nlohmann::json export_sumo(const std::filesystem::path& directory) const;
    [[nodiscard]] nlohmann::json sumo_simulate(const std::filesystem::path& directory, std::uint32_t begin_s, std::uint32_t end_s) const;
    // Adaptive Simulation Backpressure. The observer reports how far behind it
    // is; the engine throttles itself to close the gap and publishes what it did.
    // An observer showing its start-up says so. A world finished in the meantime waits at its
    // first second until the observer is ready, or stops saying so. Headless runs never wait.
    nlohmann::json observer_presence(bool waiting);
    nlohmann::json report_backpressure(double virtual_lag_s, double client_frame_s, double since_poll_s, bool away = false);
    [[nodiscard]] nlohmann::json backpressure() const;
    // Record that a payload of this size was served, for the data-rate report.
    void note_delivery(std::size_t bytes);

    [[nodiscard]] std::uint64_t state_revision() const;
    [[nodiscard]] Lifecycle lifecycle() const;
    // For watchers that must never wait on a world being compiled: nothing, while the engine is busy.
    [[nodiscard]] std::optional<double> try_virtual_seconds() const;
    [[nodiscard]] std::optional<std::string> try_map_file() const;
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
    void restore_to(std::uint32_t target);
    void rewind_to_checkpoint(std::uint32_t target); void anchor_wall_clock(); void catch_up_to_wall_clock(); void add_news(std::uint64_t event_id,std::string category,std::string severity,std::string id,std::string message,nlohmann::json data={});
    void prefetch_narrations();
    [[nodiscard]] nlohmann::json news_json(const NewsItem& item,const char* time_key,bool realistic=false) const;
    [[nodiscard]] nlohmann::json clock_json() const; [[nodiscard]] nlohmann::json envelope(nlohmann::json data) const;
    AppliedCommand& record(std::string type,nlohmann::json before,nlohmann::json after);
    [[nodiscard]] nlohmann::json signal_state_json() const;
    void apply_command(const AppliedCommand& command,bool forward);

    RuntimeLogger& logger_; mutable std::recursive_mutex mutex_; std::condition_variable_any cv_; std::jthread worker_;
    Lifecycle lifecycle_{Lifecycle::Idle};
    // Lock-free mirror of lifecycle_, written only by transition().
    std::atomic<Lifecycle> lifecycle_mirror_{Lifecycle::Idle}; ScenarioCompiler compiler_; std::map<std::string, ScenarioCompiler::Hooks> engines_; std::map<std::string, EngineIdentity> identities_;
    void require_engine(const ScenarioConfig& config) const;
    // Where a seed goes under the configuration's engine and selection policy.
    [[nodiscard]] MapLocation locate(Seed128 seed, const ScenarioConfig& config) const;
    [[nodiscard]] nlohmann::json map_selection_json(const ScenarioConfig& config) const;
    // After a failed preparation: the state of the world that was already there, or Idle if there was none.
    void return_after_failed_preparation(Lifecycle before);
    std::function<bool(Lifecycle, Lifecycle)> transition_guard_;
    std::function<bool(const std::string&, const std::string&)> world_guard_;
    // Every change of world_job_.state goes through here, with world_mutex_ held.
    void world_transition(const std::string& state, const std::string& stage);
    // A stop, reset or termination: a world staged or still being prepared is cancelled at once. Engine lock held.
    void cancel_world_job();
    std::atomic<std::uint64_t> illegal_transitions_{0};
    [[nodiscard]] Scenario compile_scenario(Seed128 seed, const ScenarioConfig& config); std::unique_ptr<GraphStore> graph_;
    std::atomic<bool> compiling_{false}; // Concurrent compiles fail without occupying HTTP workers.
    std::uint64_t compile_generation_{}; // Guarded by mutex_; reset/terminate invalidate a pending install.
    std::string preparation_error_;
    bool observer_waiting_{};
    bool observer_hold_{};
    std::chrono::steady_clock::time_point observer_seen_{};
    [[nodiscard]] bool observer_watching() const;
    void release_observer_hold();
    // What the last failed attempt asked for, so trying again can pick somewhere else.
    std::optional<Seed128> failed_seed_;
    // The city the last failed attempt was in, where the seed chose it. Caller holds mutex_.
    [[nodiscard]] std::string failed_city(const ScenarioConfig& config) const;
    std::optional<std::pair<ScenarioConfig, std::uint32_t>> failed_start_;
    std::string run_id_; std::uint32_t virtual_s_{}; std::uint32_t start_virtual_s_{}; double tick_rate_{1};
    std::chrono::steady_clock::time_point anchor_wall_{}; std::uint32_t anchor_virtual_s_{};
    std::chrono::steady_clock::time_point last_global_dump_{};
    std::vector<DwsEvent> manual_weather_; std::vector<ActiveSurgeZone> active_surges_;
    std::vector<NewsItem> news_; std::vector<AppliedCommand> commands_,redo_;
    std::vector<Checkpoint> checkpoints_; std::uint64_t next_command_id_{1},next_news_id_{1},next_event_id_{1'000'000};
    EventRuntime events_;
    mutable AdaptiveBackpressure asb_;
    double requested_tick_rate_{1.0};
    // A jump under way: where it is going, and whether the run plays on once it is there.
    std::optional<std::uint32_t> seek_target_;
    bool seek_resume_{false};
    std::chrono::steady_clock::time_point asb_epoch_{std::chrono::steady_clock::now()};
    CongestionTracker congestion_;
    std::vector<const SignalPlan*> signal_by_node_;
    std::shared_ptr<Narrator> narrator_;
    std::unique_ptr<NarrationContext> narration_context_;
    mutable std::shared_ptr<const std::string> topology_body_; // per world; reset on install
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
        std::uint64_t compile_generation{};
        // Prepared ahead of a person's confirmation, and whether it has been given.
        bool staged{false}, commit{false};
        // Cancelled by a stop, reset or termination while still being prepared: it fails when its worker finishes.
        bool cancelled{false};
        std::chrono::steady_clock::time_point started{}, finished{};
    };
    std::unique_ptr<Scenario> staged_;
    ScenarioConfig staged_config_;
    // Installs a regenerated world. A reason when it could not be.
    std::optional<std::string> install_world(Scenario scenario, const ScenarioConfig& config, std::uint64_t compile_generation, std::uint64_t generation);
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
    // How long the world being prepared will take, in seconds: from the download as it goes, and from how long the
    // last ones took, which are kept in the logs directory. Empty when nothing is being prepared.
    // `confident` when it rests on something measured: a download of known size, a city on disk, the build itself.
public:
    struct Eta {
        double seconds;
        bool confident;
    };
private:
    [[nodiscard]] std::optional<Eta> preparation_eta() const;
    void learn_preparation(double fetch_s, double build_s);
    mutable std::mutex eta_mutex_;
    std::chrono::steady_clock::time_point stage_at_[4]{};
    double fetch_s_{30.0}, build_s_{3.0};
    bool estimates_loaded_{false};
    // Dynamic Fastboot: the next world's city, fetched while this one runs.
    NextWorld next_world_;
    // When the current world was installed. A report that arrives just after a
    // swap was measured against the world that has just gone.
    std::chrono::steady_clock::time_point installed_at_{};
    [[nodiscard]] nlohmann::json world_status_locked() const;
    // Declared last so it is joined before anything it touches is destroyed.
    std::jthread world_worker_;
};

} // namespace dstns
