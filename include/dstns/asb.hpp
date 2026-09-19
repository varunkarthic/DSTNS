#pragma once

#include <cstdint>
#include <limits>
#include <deque>
#include <string>
#include <vector>

namespace dstns {

// ---------------------------------------------------------------------------
// ASB - Adaptive Simulation Backpressure
//
// The core advances virtual time on its own clock. The observer consumes
// snapshots over HTTP. When the observer cannot keep up - a slow machine, a
// dense district, a high rate multiplier - the two drift apart: the picture on
// screen stops corresponding to the state the core is in.
//
// ASB measures that drift as a normalized score in [0,1] and throttles the
// simulation to close it. The score is deliberately the only input to the
// control law, so the same drift always produces the same response.
//
// The ladder is time-based and strictly ordered. Each rung is entered only
// after the one before it has been given a fixed window to recover:
//
//   Normal      - healthy, or recovering. Full operator control.
//   Restricted  - entered when a default-state recovery failed. Rate locked to
//                 1x and reduced motion forced, for at least kRestrictedHoldS.
//   Async       - entered when Restricted also failed. The observer's GUI is
//                 suspended; the simulation keeps running and keeps streaming.
//                 Only play/pause, reset and terminate remain available.
//
// Escalation is one-way per incident and recovery is explicit, so a marginal
// system cannot oscillate between rungs on noise.
// ---------------------------------------------------------------------------

enum class AsbState : std::uint8_t { Normal = 0, Restricted, Async };

[[nodiscard]] const char* to_string(AsbState state);

// Thresholds and windows. Public so tests state the contract in the same terms
// the implementation does, rather than restating magic numbers.
inline constexpr double kAsbSyncedScore = 0.35;      // below this, considered in sync
inline constexpr double kAsbStressedScore = 0.60;    // above this, drift is real
inline constexpr double kAsbCriticalScore = 0.85;    // above this, recovery is due
inline constexpr double kAsbEscalateAfterS = 3.0;    // stressed for this long -> act
inline constexpr double kAsbRestrictedHoldS = 5.0;   // minimum time in Restricted
inline constexpr double kAsbRecoverAfterS = 3.0;     // healthy for this long -> relax

// One observation of how far the observer is behind.
struct AsbSample {
    // Seconds between the snapshot the observer last rendered and the state the
    // core currently holds, in virtual time.
    double virtual_lag_s{};
    // Wall-clock interval the observer reported between its own frames. A
    // starved client reports long frames even when its lag is small.
    double client_frame_s{};
    // Seconds since the observer last polled at all. A client that has stopped
    // asking is the strongest possible signal of desynchronization.
    double since_poll_s{};
    // Current rate multiplier, which sets how fast lag can accumulate.
    double tick_rate{1.0};
};

// What ASB did, and why. Every transition is recorded so the operator can see
// the reasoning rather than a rate that silently changed.
struct AsbAction {
    double at_monotonic_s{};
    std::string action;   // "throttle", "default_state", "restrict", "suspend", "release"
    std::string reason;
    double score{};
    double tick_rate_before{};
    double tick_rate_after{};
};

struct AsbStatus {
    AsbState state{AsbState::Normal};
    double score{};               // normalized backpressure, 0..1
    bool synced{true};
    bool rate_locked{false};      // Restricted and Async lock the multiplier at 1x
    bool motion_locked{false};    // Restricted forces reduced motion
    bool gui_suspended{false};    // Async suspends the observer's UI
    // ASB imposes a ceiling on the multiplier only while it is throttling.
    // rate_capped says whether one is in force; rate_cap is that ceiling.
    bool rate_capped{false};
    double rate_cap{0.0};
    double stressed_for_s{};
    double state_for_s{};
    // Observed data rate, so the operator can see what the link is sustaining.
    double snapshots_per_s{};
    double bytes_per_s{};
    std::vector<AsbAction> recent_actions;
};

// The controller. One instance per engine; not thread safe, so the engine holds
// it under the same lock as the rest of its state.
class AdaptiveBackpressure {
public:
    // now_s is a monotonic clock in seconds. Injected so tests drive time
    // directly instead of sleeping.
    void observe(const AsbSample& sample, double now_s);

    // Record that a snapshot of this size was served, for the data-rate report.
    void record_delivery(std::size_t bytes, double now_s);

    [[nodiscard]] AsbStatus status(double now_s) const;

    // The multiplier the engine should actually apply, given the operator's
    // request and the current state.
    [[nodiscard]] double govern_tick_rate(double requested, double now_s) const;

    [[nodiscard]] AsbState state() const { return state_; }
    [[nodiscard]] double score() const { return score_; }

    // Clear all state. Used when a run ends, so one run's backpressure never
    // colours the next.
    void reset();

private:
    void escalate(AsbState next, const std::string& reason, double now_s);
    void note(const std::string& action, const std::string& reason, double now_s,
              double before, double after);

    AsbState state_{AsbState::Normal};
    double score_{};
    double stressed_since_{-1};
    double healthy_since_{-1};
    double state_entered_{};
    double last_observed_{};
    bool default_state_tried_{false};
    // The ceiling ASB imposes. Infinity means "no limit": a healthy system must
    // run at exactly the multiplier the operator asked for.
    double cap_{std::numeric_limits<double>::infinity()};

    struct Delivery { double at; std::size_t bytes; };
    std::deque<Delivery> deliveries_;
    std::vector<AsbAction> actions_;
};

} // namespace dstns
