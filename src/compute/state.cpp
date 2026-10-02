// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/compute/state.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>

namespace dstns::compute {
namespace {
using namespace physics;

std::uint64_t round_clamped(double value, double maximum) {
    if (!std::isfinite(value) || value <= 0) return 0;
    return static_cast<std::uint64_t>(std::llround(std::min(value, maximum)));
}

std::uint32_t u32_of(std::uint64_t v) {
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(v, std::numeric_limits<std::uint32_t>::max()));
}
} // namespace

std::uint32_t to_q30(double value) { return u32_of(round_clamped(value * 1073741824.0, 4294967295.0)); }
std::uint32_t to_q16(double value) { return u32_of(round_clamped(value * 65536.0, 4294967295.0)); }

std::int32_t to_q28(double value) {
    if (!std::isfinite(value)) return 0;
    const double scaled = std::clamp(value * 268435456.0, -2147483647.0, 2147483647.0);
    return static_cast<std::int32_t>(std::llround(scaled));
}

std::int32_t to_pos(double metres) {
    if (!std::isfinite(metres)) return 0;
    const double scaled = std::clamp(metres * 256.0, -1073741824.0, 1073741824.0);
    return static_cast<std::int32_t>(std::llround(scaled));
}

std::uint32_t to_pos_radius(double metres) {
    return static_cast<std::uint32_t>(std::max<std::uint64_t>(1, round_clamped(metres * 256.0, 2147483647.0)));
}

StaticTables build_static_tables(const Scenario& s) {
    StaticTables t;
    t.node_count = static_cast<std::uint32_t>(s.nodes.size());
    t.edge_count = static_cast<std::uint32_t>(s.edges.size());
    t.signal_count = static_cast<std::uint32_t>(s.signals.size());
    t.node_stride = stride_for(t.node_count);
    t.edge_stride = stride_for(t.edge_count);
    t.signal_stride = stride_for(std::max<std::size_t>(t.signal_count, 1));
    t.node_words.assign(std::size_t(NODE_STATIC_FIELDS) * t.node_stride, 0);
    t.edge_words.assign(std::size_t(EDGE_STATIC_FIELDS) * t.edge_stride, 0);
    auto node = [&](std::uint32_t field, std::uint32_t i) -> std::uint32_t& { return t.node_words[std::size_t(field) * t.node_stride + i]; };
    auto edge = [&](std::uint32_t field, std::uint32_t i) -> std::uint32_t& { return t.edge_words[std::size_t(field) * t.edge_stride + i]; };

    for (const auto& n : s.nodes) {
        const auto i = n.id.value;
        node(NS_X, i) = static_cast<std::uint32_t>(to_pos(n.position.x_m));
        node(NS_Y, i) = static_cast<std::uint32_t>(to_pos(n.position.y_m));
        node(NS_SUSCEPTIBILITY, i) = to_q30(std::clamp(n.flood_susceptibility, 0.0, 1.0));
        node(NS_DRAINAGE, i) = to_q30(std::clamp(n.drainage, 0.0, 1.0));
    }

    // A junction's timing plan, as the event runtime indexes it: the last plan
    // listed for a node wins.
    std::vector<std::uint32_t> signal_at(s.nodes.size(), NO_SIGNAL);
    for (std::size_t i = 0; i < s.signals.size(); ++i)
        if (s.signals[i].node.value < signal_at.size()) signal_at[s.signals[i].node.value] = static_cast<std::uint32_t>(i);

    for (const auto& e : s.edges) {
        const auto i = e.id.value;
        const auto& a = s.nodes[e.from.value].position;
        const auto& b = s.nodes[e.to.value].position;
        const double length = std::max(0.0, e.length_m);
        const double lanes = std::clamp<double>(e.lanes, 0, 255);
        const double queue = length / 7.5 * lanes;
        edge(ES_FROM, i) = e.from.value;
        edge(ES_TO, i) = e.to.value;
        edge(ES_FLAGS, i) = (is_source_direction_allowed(e) ? EDGE_ALLOWED : 0u)
                          | (std::abs(b.y_m - a.y_m) >= std::abs(b.x_m - a.x_m) ? EDGE_GROUP_A : 0u);
        edge(ES_SIGNAL, i) = e.to.value < signal_at.size() ? signal_at[e.to.value] : NO_SIGNAL;
        // Speeds are truncated, so a quantised speed never exceeds the road's.
        const auto free = static_cast<std::uint32_t>(std::clamp(std::floor(e.free_speed_mps * 65536.0), 0.0, 4294967295.0));
        edge(ES_FREE_SPEED, i) = free;
        edge(ES_FREE_FLOOR, i) = static_cast<std::uint32_t>(std::max<std::uint64_t>(K_SPEED_FLOOR_Q16, free));
        edge(ES_BASE_CAPACITY, i) = u32_of(round_clamped(e.base_capacity_vph * 256.0, 16777216.0));
        edge(ES_HOTSPOT, i) = to_q30(std::clamp(e.hotspot_susceptibility, 0.0, 1.0));
        edge(ES_QUEUE_CAPACITY, i) = u32_of(round_clamped(queue * 65536.0, 4294967295.0));
        edge(ES_CONGESTION_SCALE, i) = u32_of(round_clamped(std::max(1.0, queue * 0.75) * 65536.0, 4294967295.0));
        edge(ES_OCCUPANCY_SCALE, i) = static_cast<std::uint32_t>(std::max<std::uint64_t>(1, round_clamped(std::max(1.0, length) * lanes * 256.0, 4294967295.0)));
        edge(ES_BASELINE_COEF, i) = u32_of(round_clamped(length / 1000.0 / std::max(2.0, e.free_speed_mps * 3.6) * 16777216.0, 4294967295.0));
        edge(ES_LANES, i) = static_cast<std::uint32_t>(lanes);
        edge(ES_WEIGHT, i) = u32_of(round_clamped(length * lanes * 16.0, 4294967295.0));
        if (is_source_direction_allowed(e)) t.weight_total += edge(ES_WEIGHT, i);
    }

    std::map<std::uint32_t, std::vector<std::uint32_t>> incidents;
    for (std::size_t k = 0; k < s.incidents.size(); ++k)
        if (s.incidents[k].edge.value < t.edge_count) incidents[s.incidents[k].edge.value].push_back(static_cast<std::uint32_t>(k));
    t.incident_edges.assign(incidents.begin(), incidents.end());
    return t;
}

std::vector<std::uint32_t> initial_state(const StaticTables& t) {
    std::vector<std::uint32_t> state(t.state_words(), 0);
    const auto one = static_cast<std::uint32_t>(Q30_ONE);
    for (std::uint32_t e = 0; e < t.edge_count; ++e) {
        state[t.edge_state(EV_SIGNAL, e)] = one;
        state[t.edge_state(EV_INCIDENT_SPEED, e)] = one;
        state[t.edge_state(EV_INCIDENT_CAPACITY, e)] = one;
        if (t.edge(ES_FLAGS, e) & EDGE_ALLOWED) {
            state[t.edge_state(EV_SPEED, e)] = t.edge(ES_FREE_SPEED, e);
            state[t.edge_state(EV_MEAN_SPEED, e)] = t.edge(ES_FREE_SPEED, e);
            state[t.edge_state(EV_CAPACITY, e)] = t.edge(ES_BASE_CAPACITY, e);
        }
    }
    return state;
}

void InputMirror::reset(const StaticTables& t) {
    words_.assign(t.input_words(), 0);
    const auto one = static_cast<std::uint32_t>(Q30_ONE);
    for (std::uint32_t e = 0; e < t.edge_count; ++e) {
        words_[t.edge_input(IN_MANUAL_SPEED, e)] = one;
        words_[t.edge_input(IN_MANUAL_CAPACITY, e)] = one;
        words_[t.edge_input(IN_INCIDENT_SPEED, e)] = one;
        words_[t.edge_input(IN_INCIDENT_CAPACITY, e)] = one;
    }
    dirty_flag_.assign(words_.size(), false);
    dirty_.clear();
    full_ = true;
}

void InputMirror::mark_uploaded() {
    for (const auto offset : dirty_) dirty_flag_[offset] = false;
    dirty_.clear();
    full_ = false;
}

void StepParams::begin(const StaticTables& t, std::uint32_t virtual_s, std::uint32_t dt, std::uint32_t modules, std::uint32_t day_q30) {
    words.assign(P_HEADER_WORDS, 0);
    words[P_VIRTUAL_S] = virtual_s;
    words[P_DT] = dt;
    words[P_MODULES] = modules;
    words[P_DAY] = day_q30;
    words[P_NODE_COUNT] = t.node_count;
    words[P_EDGE_COUNT] = t.edge_count;
    words[P_NODE_STRIDE] = t.node_stride;
    words[P_EDGE_STRIDE] = t.edge_stride;
    words[P_SIGNAL_COUNT] = t.signal_count;
    words[P_SIGNAL_STRIDE] = t.signal_stride;
}

void StepParams::add_storm(std::int32_t x, std::int32_t y, std::uint32_t radius, std::uint32_t intensity) {
    // Storms precede surges in the parameter block, so a storm may only be
    // added while there are no surges yet.
    words.insert(words.begin() + P_HEADER_WORDS + std::ptrdiff_t(STORM_WORDS) * words[P_STORM_COUNT],
                 {static_cast<std::uint32_t>(x), static_cast<std::uint32_t>(y), radius, intensity});
    ++words[P_STORM_COUNT];
}

void StepParams::add_surge(std::int32_t x, std::int32_t y, std::uint32_t radius, std::uint32_t factor) {
    words.insert(words.end(), {static_cast<std::uint32_t>(x), static_cast<std::uint32_t>(y), radius, factor});
    ++words[P_SURGE_COUNT];
}

void cpu_node_pass(const StaticTables& t, const StepParams& p, std::vector<std::uint32_t>& state) {
    const auto dt = u64(p.words[P_DT]);
    const bool flooding = (p.words[P_MODULES] & MOD_FLOODING) != 0;
    const auto storms = p.words[P_STORM_COUNT];
    const auto* storm = p.words.data() + P_HEADER_WORDS;
    for (std::uint32_t n = 0; n < t.node_count; ++n) {
        const auto x = i64(static_cast<std::int32_t>(t.node(NS_X, n)));
        const auto y = i64(static_cast<std::int32_t>(t.node(NS_Y, n)));
        u64 dry = Q30_ONE;
        for (std::uint32_t k = 0; k < storms; ++k) {
            const auto* w = storm + std::size_t(k) * STORM_WORDS;
            dry = combine_rain(dry, storm_factor(x, y, i64(static_cast<std::int32_t>(w[0])), i64(static_cast<std::int32_t>(w[1])), u64(w[2]), u64(w[3])));
        }
        const u64 rain = Q30_ONE - dry;
        auto& flood = state[t.node_state(NV_FLOOD, n)];
        state[t.node_state(NV_RAIN, n)] = static_cast<std::uint32_t>(rain);
        flood = static_cast<std::uint32_t>(flood_step(u64(flood), rain, u64(t.node(NS_SUSCEPTIBILITY, n)), u64(t.node(NS_DRAINAGE, n)), dt, flooding));
    }
}

void cpu_edge_pass(const StaticTables& t, const StepParams& p, const std::vector<std::uint32_t>& in,
                   std::vector<std::uint32_t>& state, std::uint32_t begin, std::uint32_t end, StepResult& result) {
    const auto dt = u64(p.words[P_DT]);
    const auto day = u64(p.words[P_DAY]);
    const auto modules = p.words[P_MODULES];
    const bool signals = (modules & MOD_SIGNALS) != 0;
    const auto storms = p.words[P_STORM_COUNT];
    const auto surges = p.words[P_SURGE_COUNT];
    const auto* surge_words = p.words.data() + P_HEADER_WORDS + std::size_t(storms) * STORM_WORDS;
    const auto* overrides = in.data() + t.override_base();
    const auto* phases = in.data() + t.phase_base();

    // Each field of each array, resolved once: the loop indexes by edge.
    auto stat = [&](std::uint32_t f) { return t.edge_words.data() + std::size_t(f) * t.edge_stride; };
    auto input = [&](std::uint32_t f) { return in.data() + std::size_t(f) * t.edge_stride; };
    std::uint32_t* v[EDGE_STATE_FIELDS];
    for (std::uint32_t f = 0; f < EDGE_STATE_FIELDS; ++f) v[f] = state.data() + t.edge_state(f, 0);
    const auto* node_x = t.node_words.data() + std::size_t(NS_X) * t.node_stride;
    const auto* node_y = t.node_words.data() + std::size_t(NS_Y) * t.node_stride;
    const auto* node_rain = state.data() + t.node_state(NV_RAIN, 0);
    const auto* node_flood = state.data() + t.node_state(NV_FLOOD, 0);
    const auto *s_from = stat(ES_FROM), *s_to = stat(ES_TO), *s_flags = stat(ES_FLAGS), *s_signal = stat(ES_SIGNAL);
    const auto *s_free = stat(ES_FREE_SPEED), *s_floor = stat(ES_FREE_FLOOR), *s_capacity = stat(ES_BASE_CAPACITY);
    const auto *s_hotspot = stat(ES_HOTSPOT), *s_queue = stat(ES_QUEUE_CAPACITY), *s_cscale = stat(ES_CONGESTION_SCALE);
    const auto *s_oscale = stat(ES_OCCUPANCY_SCALE), *s_coef = stat(ES_BASELINE_COEF), *s_lanes = stat(ES_LANES), *s_weight = stat(ES_WEIGHT);
    const auto *i_mspeed = input(IN_MANUAL_SPEED), *i_mcap = input(IN_MANUAL_CAPACITY), *i_mclosed = input(IN_MANUAL_CLOSED);
    const auto *i_ispeed = input(IN_INCIDENT_SPEED), *i_icap = input(IN_INCIDENT_CAPACITY), *i_iclosed = input(IN_INCIDENT_CLOSED);
    const auto* i_attraction = input(IN_ATTRACTION);

    for (std::uint32_t e = begin; e < end; ++e) {
        const auto from = s_from[e];
        const auto to = s_to[e];
        const auto flags = s_flags[e];
        EdgeConstants s;
        s.flags = flags;
        s.free_speed = s_free[e];
        s.free_floor = s_floor[e];
        s.base_capacity = s_capacity[e];
        s.hotspot = s_hotspot[e];
        s.queue_capacity = s_queue[e];
        s.congestion_scale = s_cscale[e];
        s.occupancy_scale = s_oscale[e];
        s.baseline_coef = s_coef[e];
        s.lanes = s_lanes[e];

        EdgeValues prev;
        prev.rain = v[EV_RAIN][e];
        prev.flood = v[EV_FLOOD][e];
        prev.flags = v[EV_FLAGS][e];
        prev.demand = i64(static_cast<std::int32_t>(v[EV_DEMAND][e]));
        prev.capacity = v[EV_CAPACITY][e];
        prev.speed = v[EV_SPEED][e];
        prev.load = v[EV_LOAD][e];
        prev.mean_speed = v[EV_MEAN_SPEED][e];
        prev.count = v[EV_COUNT][e];
        prev.halting = v[EV_HALTING][e];
        prev.congestion_model = v[EV_CONGESTION_MODEL][e];
        prev.congestion_observed = v[EV_CONGESTION_OBSERVED][e];
        prev.congestion = v[EV_CONGESTION][e];
        prev.occupancy = v[EV_OCCUPANCY][e];
        prev.signal = v[EV_SIGNAL][e];
        prev.incident_speed = v[EV_INCIDENT_SPEED][e];
        prev.incident_capacity = v[EV_INCIDENT_CAPACITY][e];

        EdgeControls c;
        c.manual_speed = i_mspeed[e];
        c.manual_capacity = i_mcap[e];
        c.manual_closed = i_mclosed[e] != 0;
        c.incident_speed = i_ispeed[e];
        c.incident_capacity = i_icap[e];
        c.incident_closed = i_iclosed[e] != 0;
        const auto attraction = i64(static_cast<std::int32_t>(i_attraction[e]));

        u64 surge = Q16_ONE;
        if (surges != 0) {
            const auto fx = i64(static_cast<std::int32_t>(node_x[from]));
            const auto fy = i64(static_cast<std::int32_t>(node_y[from]));
            const auto tx = i64(static_cast<std::int32_t>(node_x[to]));
            const auto ty = i64(static_cast<std::int32_t>(node_y[to]));
            for (std::uint32_t k = 0; k < surges; ++k) {
                const auto* w = surge_words + std::size_t(k) * SURGE_WORDS;
                if (surge_reaches(fx, fy, tx, ty, i64(static_cast<std::int32_t>(w[0])), i64(static_cast<std::int32_t>(w[1])), u64(w[2])))
                    surge = umax64(surge, u64(w[3]));
            }
        }
        const auto plan = s_signal[e];
        const auto phase = plan != NO_SIGNAL ? phases[plan] : 0u;
        const auto signal = signal_factor(signals, plan != NO_SIGNAL, phase, (flags & EDGE_GROUP_A) != 0, overrides[to]);

        const auto o = edge_step(s, prev, node_rain[from], node_rain[to], node_flood[from], node_flood[to],
                                 c, attraction, surge, signal, dt, day, modules);

        v[EV_RAIN][e] = o.rain;
        v[EV_FLOOD][e] = o.flood;
        v[EV_FLAGS][e] = o.flags;
        v[EV_DEMAND][e] = static_cast<std::uint32_t>(static_cast<std::int32_t>(o.demand));
        v[EV_CAPACITY][e] = o.capacity;
        v[EV_SPEED][e] = o.speed;
        v[EV_LOAD][e] = o.load;
        v[EV_MEAN_SPEED][e] = o.mean_speed;
        v[EV_COUNT][e] = o.count;
        v[EV_HALTING][e] = o.halting;
        v[EV_CONGESTION_MODEL][e] = o.congestion_model;
        v[EV_CONGESTION_OBSERVED][e] = o.congestion_observed;
        v[EV_CONGESTION][e] = o.congestion;
        v[EV_OCCUPANCY][e] = o.occupancy;
        v[EV_SIGNAL][e] = o.signal;
        v[EV_INCIDENT_SPEED][e] = o.incident_speed;
        v[EV_INCIDENT_CAPACITY][e] = o.incident_capacity;
        if (o.flags & STATE_FLOOD_TRANSITION) ++result.transitions;
        result.congestion_sum += congestion_contribution(flags, s_weight[e], u64(o.congestion));
    }
}

} // namespace dstns::compute
