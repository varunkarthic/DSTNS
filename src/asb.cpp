#include "dstns/asb.hpp"

#include <algorithm>
#include <limits>
#include <cmath>

namespace dstns {
namespace {

// Rolling window for the delivered-data rate.
constexpr double kRateWindowS = 5.0;
// Keep the action log short: it is an explanation, not an audit trail.
constexpr std::size_t kMaxActions = 24;

// Lag is scored against what the current rate makes reasonable. At 1x a second
// of drift is a lot; at 20x the observer is expected to be a few virtual
// seconds behind simply because each poll covers more ground.
double lag_component(const AsbSample& s) {
    const double tolerance = std::max(1.0, 1.5 * std::max(1.0, s.tick_rate));
    return std::clamp(s.virtual_lag_s / (tolerance * 4.0), 0.0, 1.0);
}

// A client rendering at 16ms is fine; at 100ms it is visibly struggling.
double frame_component(const AsbSample& s) {
    if (s.client_frame_s <= 0) return 0.0;
    return std::clamp((s.client_frame_s - 0.033) / 0.20, 0.0, 1.0);
}

// Polling should happen about once a second. Silence is the loudest signal.
double poll_component(const AsbSample& s) {
    return std::clamp((s.since_poll_s - 2.0) / 6.0, 0.0, 1.0);
}

} // namespace

const char* to_string(AsbState state) {
    switch (state) {
        case AsbState::Normal: return "NORMAL";
        case AsbState::Restricted: return "RESTRICTED";
        case AsbState::Async: return "ASYNC";
    }
    return "NORMAL";
}

void AdaptiveBackpressure::note(const std::string& action, const std::string& reason,
                                double now_s, double before, double after) {
    actions_.push_back({now_s, action, reason, score_, before, after});
    if (actions_.size() > kMaxActions) actions_.erase(actions_.begin());
}

void AdaptiveBackpressure::escalate(AsbState next, const std::string& reason, double now_s) {
    if (next == state_) return;
    state_ = next;
    state_entered_ = now_s;
    stressed_since_ = -1;
    healthy_since_ = -1;
    const double before = cap_;
    cap_ = next == AsbState::Normal ? std::numeric_limits<double>::infinity() : 1.0;
    note(next == AsbState::Restricted ? "restrict"
         : next == AsbState::Async    ? "suspend"
                                      : "release",
         reason, now_s, before, cap_);
}

void AdaptiveBackpressure::observe(const AsbSample& sample, double now_s) {
    last_observed_ = now_s;

    // The worst single symptom drives the score. Averaging would let a severe
    // problem in one dimension hide behind health in the others.
    score_ = std::max({lag_component(sample), frame_component(sample), poll_component(sample)});

    const bool stressed = score_ > kAsbStressedScore;
    const bool healthy = score_ < kAsbSyncedScore;

    if (stressed) {
        if (stressed_since_ < 0) stressed_since_ = now_s;
        healthy_since_ = -1;
    } else if (healthy) {
        if (healthy_since_ < 0) healthy_since_ = now_s;
        stressed_since_ = -1;
    } else {
        // Between the two thresholds: hold position rather than flapping.
        stressed_since_ = stressed_since_ < 0 ? -1 : stressed_since_;
        healthy_since_ = -1;
    }

    const double stressed_for = stressed_since_ < 0 ? 0.0 : now_s - stressed_since_;
    const double healthy_for = healthy_since_ < 0 ? 0.0 : now_s - healthy_since_;
    const double in_state_for = now_s - state_entered_;

    switch (state_) {
        case AsbState::Normal: {
            if (!stressed) {
                // Proportional release back towards what the operator asked for.
                if (healthy && std::isfinite(cap_)) {
                    const double before = cap_;
                    // Ease the ceiling up, and drop it entirely once it no
                    // longer binds what the operator asked for.
                    cap_ = cap_ * 1.5 + 0.5;
                    if (cap_ >= sample.tick_rate) cap_ = std::numeric_limits<double>::infinity();
                    note("throttle", "recovering; easing the rate ceiling back up",
                         now_s, before, cap_);
                }
                default_state_tried_ = healthy_for > kAsbRecoverAfterS ? false : default_state_tried_;
                break;
            }
            // Stressed: throttle proportionally straight away. This is the
            // cheap, continuous response that usually suffices.
            const double before = cap_;
            const double target = std::max(1.0, sample.tick_rate * (1.0 - score_));
            cap_ = std::min(cap_, target);
            if (cap_ < before)
                note("throttle", "observer behind; reducing the rate ceiling to close the gap",
                     now_s, before, cap_);

            if (stressed_for >= kAsbEscalateAfterS) {
                if (!default_state_tried_) {
                    // One forced reset of the whole presentation: 1x, layers off,
                    // soft reload of the observer. The engine and the UI act on
                    // this via the published status.
                    default_state_tried_ = true;
                    stressed_since_ = now_s;  // give the recovery its own window
                    const double was = cap_;
                    cap_ = 1.0;
                    note("default_state",
                         "backpressure sustained past the escalation window; forcing 1x, "
                         "disabling display layers and soft-restarting the observer",
                         now_s, was, cap_);
                } else if (score_ > kAsbCriticalScore || stressed_for >= kAsbEscalateAfterS * 2) {
                    escalate(AsbState::Restricted,
                             "default state did not restore synchronization", now_s);
                }
            }
            break;
        }
        case AsbState::Restricted: {
            // Hold for a minimum period regardless, so the system has a genuine
            // chance to settle before it is judged again.
            if (in_state_for < kAsbRestrictedHoldS) break;
            if (healthy && healthy_for >= kAsbRecoverAfterS) {
                default_state_tried_ = false;
                escalate(AsbState::Normal, "synchronization restored; releasing restrictions", now_s);
            } else if (stressed && stressed_for >= kAsbEscalateAfterS) {
                escalate(AsbState::Async,
                         "restricted operation did not restore synchronization", now_s);
            }
            break;
        }
        case AsbState::Async: {
            // The GUI is suspended; only a sustained recovery brings it back.
            if (healthy && healthy_for >= kAsbRecoverAfterS * 2) {
                default_state_tried_ = false;
                escalate(AsbState::Normal, "observer resynchronized; resuming the interface", now_s);
            }
            break;
        }
    }

    (void)in_state_for;
}

void AdaptiveBackpressure::record_delivery(std::size_t bytes, double now_s) {
    deliveries_.push_back({now_s, bytes});
    while (!deliveries_.empty() && now_s - deliveries_.front().at > kRateWindowS)
        deliveries_.pop_front();
}

AsbStatus AdaptiveBackpressure::status(double now_s) const {
    AsbStatus out;
    out.state = state_;
    out.score = score_;
    out.synced = score_ < kAsbSyncedScore;
    out.rate_locked = state_ != AsbState::Normal;
    out.motion_locked = state_ != AsbState::Normal;
    out.gui_suspended = state_ == AsbState::Async;
    out.rate_capped = state_ != AsbState::Normal || std::isfinite(cap_);
    out.rate_cap = out.rate_capped ? (state_ == AsbState::Normal ? cap_ : 1.0) : 0.0;
    out.stressed_for_s = stressed_since_ < 0 ? 0.0 : now_s - stressed_since_;
    out.state_for_s = now_s - state_entered_;

    if (!deliveries_.empty()) {
        const double span = std::max(0.001, now_s - deliveries_.front().at);
        std::size_t bytes = 0;
        for (const auto& d : deliveries_) bytes += d.bytes;
        out.snapshots_per_s = double(deliveries_.size()) / span;
        out.bytes_per_s = double(bytes) / span;
    }
    out.recent_actions = actions_;
    return out;
}

double AdaptiveBackpressure::govern_tick_rate(double requested, double now_s) const {
    (void)now_s;
    // Outside Normal the multiplier is pinned; inside it, ASB only ever lowers
    // what was asked for, and never below real time.
    if (state_ != AsbState::Normal) return 1.0;
    if (!std::isfinite(cap_)) return requested;
    return std::min(requested, std::max(cap_, 1.0));
}

void AdaptiveBackpressure::reset() {
    state_ = AsbState::Normal;
    score_ = 0;
    stressed_since_ = -1;
    healthy_since_ = -1;
    state_entered_ = 0;
    last_observed_ = 0;
    default_state_tried_ = false;
    cap_ = std::numeric_limits<double>::infinity();
    deliveries_.clear();
    actions_.clear();
}

} // namespace dstns
