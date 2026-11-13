// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// core-ng's compile modules on their own: each is a pure function of its inputs, and the order of independent modules
// does not change what they make. (Equality with core-legacy is dstns_golden's job.)
#include "dstns/core-ng/compile.hpp"
#include "dstns/core-ng/selection.hpp"

#include <iostream>
#include <stdexcept>
#include <string>

using namespace dstns;
namespace plan = dstns::core_ng::plan;

namespace {
void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

template <class F> void refuses(F&& f, const std::string& what) {
    try {
        f();
    } catch (const std::invalid_argument&) {
        return;
    }
    throw std::runtime_error("accepted " + what);
}
} // namespace

int main() {
    try {
        const auto seed = Seed128::from_decimal("382923");
        ScenarioConfig config;
        config.grid_width = 9; config.grid_height = 8; config.dws_frequency = 5; config.playback_duration_s = 900;
        const auto whole = core_ng::compile(seed, config);
        check(!whole.nodes.empty() && !whole.trips.empty() && !whole.incidents.empty() && whole.dws_events.size() == 5, "a whole scenario");
        check(core_ng::compile(seed, config).scenario_hash == whole.scenario_hash, "compile is repeatable");

        // The network alone, then the planners on copies of it, in either order.
        Scenario base = whole;
        base.signals.clear(); base.hotspot_edges.clear(); base.trips.clear(); base.dws_events.clear(); base.incidents.clear();
        for (auto& edge : base.edges) edge.hotspot_susceptibility = 0;
        for (auto& node : base.nodes) { node.signal_cycle_s = 0; node.signal_green_s = 0; node.signal_offset_s = 0; }
        const DeterministicRng dws{seed.derive("dws")}, incidents{seed.derive("incidents")};
        Scenario a = base, b = base;
        plan::weather(a, dws); plan::incidents(a, incidents);
        plan::incidents(b, incidents); plan::weather(b, dws);
        check(a.dws_events.size() == b.dws_events.size() && a.incidents.size() == b.incidents.size(), "same counts in either order");
        for (std::size_t i = 0; i < a.incidents.size(); ++i)
            check(a.incidents[i].edge == b.incidents[i].edge && a.incidents[i].start_virtual_s == b.incidents[i].start_virtual_s, "incidents do not depend on order");
        for (std::size_t i = 0; i < a.dws_events.size(); ++i)
            check(a.dws_events[i].epicenter == b.dws_events[i].epicenter && a.dws_events[i].start_ppm == b.dws_events[i].start_ppm, "storms do not depend on order");
        check(a.incidents.size() == whole.incidents.size() && a.incidents.front().id == whole.incidents.front().id &&
              a.incidents.front().edge == whole.incidents.front().edge, "a module alone makes what the whole compile made");

        // Hashes cover what they claim: the same scenario, the same hashes; one storm moved, a new event hash.
        Scenario c = whole;
        plan::hashes(c);
        check(c.graph_hash == whole.graph_hash && c.event_hash == whole.event_hash && c.scenario_hash == whole.scenario_hash, "hashes are repeatable");
        c.dws_events.front().start_ppm += 1;
        plan::hashes(c);
        check(c.graph_hash == whole.graph_hash && c.event_hash != whole.event_hash && c.scenario_hash != whole.scenario_hash, "an event change moves the event hash only");

        // Refused before anything is read: an invalid policy, and limits.
        auto bad_policy = config;
        bad_policy.osm_file = "auto";
        bad_policy.map_cache_dir = "/nonexistent/never-read";
        bad_policy.map_selection_version = "urban-geo-v1";
        bad_policy.map_selection_mode = "countries";
        bad_policy.map_countries = {"XX"};
        refuses([&] { (void)core_ng::compile(seed, bad_policy); }, "an unknown country");
        auto tiny = config;
        tiny.max_nodes = 1;
        refuses([&] { (void)core_ng::compile(seed, tiny); }, "max_nodes 1");
        auto day = config;
        day.day = 2;
        refuses([&] { (void)core_ng::compile(seed, day); }, "day 2");

        std::cout << "[compile-ng] modules are repeatable, order-independent and hashed as claimed; invalid input refused\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
