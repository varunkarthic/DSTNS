// Adaptive Simulation Backpressure: the escalation ladder, the control law and
// the guarantees the operator is promised.
//
// Time is injected, so every window is exercised exactly rather than by
// sleeping and hoping.
#include "dstns/asb.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace dstns;

int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "  FAIL: " << message << '\n';
        ++failures;
    }
}

// A comfortably healthy observer.
AsbSample healthy(double rate = 1.0) {
    return {0.05, 0.016, 0.9, rate};
}
// An observer badly behind on every axis.
AsbSample drowning(double rate = 1.0) {
    return {60.0, 0.40, 9.0, rate};
}

// Advance the controller across a span, sampling every 250ms.
double feed(AdaptiveBackpressure& asb, const AsbSample& sample, double from, double seconds) {
    double t = from;
    for (double elapsed = 0; elapsed < seconds; elapsed += 0.25) {
        t = from + elapsed;
        asb.observe(sample, t);
    }
    return t;
}

int main() {
    // ---- A healthy observer is never interfered with ---------------------
    {
        AdaptiveBackpressure asb;
        const double t = feed(asb, healthy(5.0), 0, 30);
        const auto s = asb.status(t);
        check(s.state == AsbState::Normal, "a healthy observer stays in Normal");
        check(s.synced, "a healthy observer reports synced");
        check(s.score < kAsbSyncedScore, "a healthy observer scores below the synced threshold");
        check(!s.rate_locked && !s.motion_locked && !s.gui_suspended,
              "Normal imposes no locks");
        check(asb.govern_tick_rate(5.0, t) == 5.0,
              "a healthy observer keeps the rate the operator asked for");
    }

    // ---- Score is normalized and monotone in the drift --------------------
    {
        AdaptiveBackpressure asb;
        asb.observe(healthy(), 0);
        const double low = asb.score();
        asb.observe({4.0, 0.016, 0.9, 1.0}, 1);
        const double mid = asb.score();
        asb.observe(drowning(), 2);
        const double high = asb.score();
        check(low >= 0 && high <= 1, "score stays within [0,1]");
        check(low < mid && mid < high, "score rises with drift");
    }

    // ---- Each symptom alone is enough to register -------------------------
    {
        AdaptiveBackpressure asb;
        asb.observe({60.0, 0.016, 0.9, 1.0}, 0);
        check(asb.score() > kAsbStressedScore, "virtual lag alone registers as stress");
        asb.observe({0.05, 0.40, 0.9, 1.0}, 1);
        check(asb.score() > kAsbStressedScore, "a starved client frame rate alone registers");
        asb.observe({0.05, 0.016, 9.0, 1.0}, 2);
        check(asb.score() > kAsbStressedScore, "an observer that stopped polling alone registers");
    }

    // ---- Throttling happens before any escalation -------------------------
    {
        AdaptiveBackpressure asb;
        asb.observe(drowning(5.0), 0);
        const double governed = asb.govern_tick_rate(5.0, 0);
        check(governed < 5.0, "a stressed observer is throttled immediately");
        check(governed >= 1.0, "throttling never drops below real time");
        check(asb.state() == AsbState::Normal,
              "throttling alone does not change state");
    }

    // ---- The default state is tried once, before Restricted ---------------
    {
        AdaptiveBackpressure asb;
        double t = feed(asb, drowning(5.0), 0, kAsbEscalateAfterS + 0.5);
        auto s = asb.status(t);
        bool forced = false;
        for (const auto& a : s.recent_actions) if (a.action == "default_state") forced = true;
        check(forced, "sustained backpressure forces the default state first");
        check(s.state == AsbState::Normal,
              "the default state is attempted while still in Normal");
    }

    // ---- Restricted: entered on failed recovery, locks rate and motion ----
    {
        AdaptiveBackpressure asb;
        double t = feed(asb, drowning(5.0), 0, 6.25);
        auto s = asb.status(t);
        check(s.state == AsbState::Restricted, "failed default recovery enters Restricted at 6s");
        {
            check(s.rate_locked, "Restricted locks the rate");
            check(s.motion_locked, "Restricted forces reduced motion");
            check(!s.gui_suspended, "Restricted does not suspend the interface");
            check(asb.govern_tick_rate(5.0, t) == 1.0,
                  "Restricted pins the multiplier at 1x whatever is requested");
        }
    }

    // ---- Restricted is held for its minimum before any judgement ----------
    {
        AdaptiveBackpressure asb;
        double t = feed(asb, drowning(5.0), 0, 6.25);
        check(asb.state() == AsbState::Restricted, "Restricted hold precondition");
        {
            const double entered = t;
            // Recover immediately; the hold must still be honoured.
            t = feed(asb, healthy(), entered + 0.25, kAsbRestrictedHoldS - 1.0);
            check(asb.state() == AsbState::Restricted,
                  "Restricted is held for its minimum period even once healthy");
        }
    }

    // ---- Async: the terminal rung, GUI suspended, simulation untouched ----
    {
        AdaptiveBackpressure asb;
        double t = feed(asb, drowning(5.0), 0, 60);
        const auto s = asb.status(t);
        check(s.state == AsbState::Async, "persistent failure reaches Async");
        check(s.gui_suspended, "Async suspends the interface");
        check(s.rate_locked, "Async keeps the rate locked");
        check(asb.govern_tick_rate(5.0, t) == 1.0, "Async runs the simulation at 1x");
        bool suspended = false;
        for (const auto& a : s.recent_actions) if (a.action == "suspend") suspended = true;
        check(suspended, "the suspension is recorded with a reason");
    }

    // ---- Recovery walks back down, and only after a sustained good spell --
    {
        AdaptiveBackpressure asb;
        double t = feed(asb, drowning(5.0), 0, 60);
        check(asb.state() == AsbState::Async, "reached Async before testing recovery");
        // A brief good patch must not release it.
        t = feed(asb, healthy(), t + 0.25, 1.0);
        check(asb.state() == AsbState::Async, "a momentary recovery does not release Async");
        // A sustained one must.
        t = feed(asb, healthy(), t + 0.25, kAsbRecoverAfterS * 2 + 2.0);
        check(asb.state() == AsbState::Normal, "a sustained recovery returns to Normal");
        const auto s = asb.status(t);
        check(!s.gui_suspended && !s.rate_locked, "returning to Normal lifts every lock");
        check(asb.govern_tick_rate(5.0, t) == 5.0, "recovery restores the requested rate");
    }

    // ---- Noise must not flap the state ------------------------------------
    {
        AdaptiveBackpressure asb;
        double t = 0;
        // Alternate either side of the synced threshold, never sustained.
        for (int i = 0; i < 200; ++i, t += 0.25)
            asb.observe(i % 2 ? healthy() : AsbSample{3.0, 0.05, 1.0, 1.0}, t);
        check(asb.state() == AsbState::Normal, "alternating marginal samples never escalate");
    }

    // ---- Actions are explained, and the log stays bounded -----------------
    {
        AdaptiveBackpressure asb;
        double t = feed(asb, drowning(5.0), 0, 120);
        const auto s = asb.status(t);
        check(!s.recent_actions.empty(), "transitions are recorded");
        check(s.recent_actions.size() <= 24, "the action log is bounded");
        for (const auto& a : s.recent_actions) {
            check(!a.action.empty(), "every action is named");
            check(!a.reason.empty(), "every action carries a reason");
        }
    }

    // ---- The delivered data rate is reported ------------------------------
    {
        AdaptiveBackpressure asb;
        for (int i = 0; i < 10; ++i) asb.record_delivery(50'000, i * 0.5);
        const auto s = asb.status(4.5);
        check(s.snapshots_per_s > 1.0 && s.snapshots_per_s < 4.0,
              "snapshot rate reflects what was delivered");
        check(s.bytes_per_s > 50'000, "byte rate reflects what was delivered");
    }

    // ---- Reset clears everything, so one run cannot colour the next -------
    {
        AdaptiveBackpressure asb;
        const double t = feed(asb, drowning(5.0), 0, 60);
        asb.record_delivery(1000, t);
        check(asb.state() != AsbState::Normal, "state was dirty before reset");
        asb.reset();
        const auto s = asb.status(0);
        check(s.state == AsbState::Normal, "reset returns to Normal");
        check(s.score == 0, "reset clears the score");
        check(s.recent_actions.empty(), "reset clears the action log");
        check(s.bytes_per_s == 0, "reset clears the delivery window");
        check(asb.govern_tick_rate(5.0, 0) == 5.0, "reset restores full operator control");
    }

    // ---- to_string covers every state -------------------------------------
    check(std::string(to_string(AsbState::Normal)) == "NORMAL", "Normal stringifies");
    check(std::string(to_string(AsbState::Restricted)) == "RESTRICTED", "Restricted stringifies");
    check(std::string(to_string(AsbState::Async)) == "ASYNC", "Async stringifies");

    if (failures) {
        std::cerr << failures << " ASB assertion(s) failed\n";
        return 1;
    }
    std::cout << "ASB invariants passed\n";
    return 0;
}
