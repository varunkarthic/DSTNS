// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The DSTNS physics step, written once for every compute backend.
//
// This file is compiled twice: as C++ by the CPU reference backend
// (include/dstns/compute/physics.hpp wraps it in a namespace) and as GLSL by
// the Vulkan compute shaders (shaders/*.comp include it). Because both
// backends execute the same integer operations in the same order, they produce
// the same bits. There is deliberately no floating point here: GPU drivers may
// contract, reassociate or flush floating-point arithmetic, but integer
// arithmetic is exact on every conformant implementation.
//
// The subset of the language used is the intersection of C++20 and GLSL 4.60
// with GL_EXT_shader_explicit_arithmetic_types_int64:
//   - u32, u64, i64 are provided by the including file;
//   - every literal is wrapped in a constructor (u64(5u)) so that no implicit
//     conversion, whose rules differ between the languages, is ever relied on;
//   - functions take and return values; no references, pointers or arrays;
//   - signed values are shifted right only where floor division is intended
//     (arithmetic shift in both languages) and are never divided.
//
// Every real quantity is fixed point. The formats, chosen from the range and
// precision each quantity needs, are documented in docs/concepts/compute.md:
//   Q30  unsigned  fractions and multipliers, 1.0 = 2^30, range [0, 4)
//   Q28  signed    demand attraction, range (-8, 8)
//   Q24  unsigned  queue baseline coefficient (h), range [0, 256)
//   Q16  unsigned  speeds (m/s), vehicles, surge factors, range [0, 65536)
//   Q8   signed    flows (veh/h), range +/-2^23
//   POS  signed    positions, 1/256 m, int32
//
// Products are truncated (floor) unless a comment says otherwise. Rounding to
// the nearest integer, where the original model used llround, adds half an
// ulp before truncating.

// --- Fixed-point scales -------------------------------------------------------

const u64 Q30_ONE = u64(1073741824u);
const u64 Q16_ONE = u64(65536u);

// --- Model coefficients (Q30 unless noted), rounded to nearest ----------------

const u64 K_RAIN_FLOOD_GAIN = u64(19327353u);   // 0.018 per s
const u64 K_FLOOD_DRAINAGE = u64(4294967u);     // 0.004 per s
const u64 K_DEMAND_BASE = u64(193273528u);      // 0.18
const u64 K_DEMAND_DAY = u64(730144440u);       // 0.68
const u64 K_DEMAND_PLACES = u64(644245094u);    // 0.60
const u64 K_DEMAND_HOTSPOT = u64(375809638u);   // 0.35
const u64 K_RAIN_SPEED = u64(193273528u);       // 0.18
const u64 K_FLOOD_SPEED = u64(590558003u);      // 0.55
const u64 K_FLOOD_SPEED_FLOOR = u64(375809638u);// 0.35
const u64 K_RAIN_CAPACITY = u64(161061274u);    // 0.15
const u64 K_FLOOD_CAPACITY = u64(644245094u);   // 0.60
const u64 K_FLOOD_CAPACITY_FLOOR = u64(322122547u); // 0.30
const u64 K_SIGNAL_QUEUE = u64(3758096384u);    // 3.5
const u64 K_QUEUE_SLOWDOWN = u64(697932186u);   // 0.65
const u64 K_SIGNAL_HALTING = u64(966367642u);   // 0.90
const u64 K_SPEED_LOSS_WEIGHT = u64(644245094u);// 0.60
const u64 K_QUEUE_WEIGHT = u64(268435456u);     // 0.25
const u64 K_OCCUPANCY_WEIGHT = u64(161061274u); // 0.15
const u64 K_SIGNAL_AMBER = u64(429496730u);     // 0.40
const u64 K_SIGNAL_RED = u64(85899346u);        // 0.08

const u64 K_ACCELERATION_Q16 = u64(157286u);    // 2.4 m/s per s
const u64 K_DECELERATION_Q16 = u64(209715u);    // 3.2 m/s per s
const u64 K_MIN_INFLOW_Q16 = u64(26214u);       // 0.4 vehicles per step
const u64 K_MIN_DISCHARGE_Q16 = u64(45875u);    // 0.7 vehicles per step
const u64 K_LANE_DISCHARGE_Q16 = u64(49152u);   // 0.75 vehicles per lane per s
const u64 K_SPEED_FLOOR_Q16 = u64(6554u);       // 0.1 m/s, guards a division

// Thresholds, as exact integer comparisons of a Q30 value.
const u64 FLOOD_EVENT_Q30 = u64(10737418u);     // flood > 0.01 starts an event
const u64 FLOOD_CLOSED_Q30 = u64(1052266988u);  // flood >= 0.98 closes a road
const u64 FLOOD_CONTROL_CLOSED_Q30 = u64(1020054733u); // flood >= 0.95, at an operator override

// --- Buffer layout ------------------------------------------------------------
// Every per-node and per-edge quantity is a structure of arrays of 32-bit
// words: field f of element i lives at word f * stride + i. Strides are the
// element count rounded up to a multiple of 64 so each field starts aligned.

// Static node fields.
const u32 NS_X = u32(0u);
const u32 NS_Y = u32(1u);
const u32 NS_SUSCEPTIBILITY = u32(2u);
const u32 NS_DRAINAGE = u32(3u);
const u32 NODE_STATIC_FIELDS = u32(4u);

// Static edge fields.
const u32 ES_FROM = u32(0u);
const u32 ES_TO = u32(1u);
const u32 ES_FLAGS = u32(2u);
const u32 ES_SIGNAL = u32(3u);            // signal plan at the destination, or NO_SIGNAL
const u32 ES_FREE_SPEED = u32(4u);        // Q16 m/s
const u32 ES_FREE_FLOOR = u32(5u);        // Q16 max(0.1, free speed)
const u32 ES_BASE_CAPACITY = u32(6u);     // Q8 veh/h
const u32 ES_HOTSPOT = u32(7u);           // Q30
const u32 ES_QUEUE_CAPACITY = u32(8u);    // Q16 vehicles: length / 7.5 * lanes
const u32 ES_CONGESTION_SCALE = u32(9u);  // Q16 max(1, queue capacity * 0.75)
const u32 ES_OCCUPANCY_SCALE = u32(10u);  // Q8 max(1, length) * lanes
const u32 ES_BASELINE_COEF = u32(11u);    // Q24 length_km / max(2, free km/h)
const u32 ES_LANES = u32(12u);
const u32 ES_WEIGHT = u32(13u);           // congestion index weight: length * lanes, Q4
const u32 EDGE_STATIC_FIELDS = u32(14u);

const u32 EDGE_ALLOWED = u32(1u);         // a traversable source direction
const u32 EDGE_GROUP_A = u32(2u);         // north-south signal group
const u32 NO_SIGNAL = u32(4294967295u);

// Dynamic node state.
const u32 NV_RAIN = u32(0u);              // Q30
const u32 NV_FLOOD = u32(1u);             // Q30
const u32 NODE_STATE_FIELDS = u32(2u);

// Dynamic edge state. The first three fields are what the host needs after
// every step (demand couplings and flood events), so they are contiguous and
// read back with one copy.
const u32 EV_RAIN = u32(0u);              // Q30
const u32 EV_FLOOD = u32(1u);             // Q30
const u32 EV_FLAGS = u32(2u);
const u32 EV_DEMAND = u32(3u);            // Q8 veh/h, signed (two's complement)
const u32 EV_CAPACITY = u32(4u);          // Q8 veh/h
const u32 EV_SPEED = u32(5u);             // Q16 m/s, effective speed
const u32 EV_LOAD = u32(6u);              // Q16 vehicles
const u32 EV_MEAN_SPEED = u32(7u);        // Q16 m/s
const u32 EV_COUNT = u32(8u);
const u32 EV_HALTING = u32(9u);
const u32 EV_CONGESTION_MODEL = u32(10u); // Q30
const u32 EV_CONGESTION_OBSERVED = u32(11u); // Q30
const u32 EV_CONGESTION = u32(12u);       // Q30
const u32 EV_OCCUPANCY = u32(13u);        // Q30
const u32 EV_SIGNAL = u32(14u);           // Q30 signal multiplier
const u32 EV_INCIDENT_SPEED = u32(15u);   // Q30
const u32 EV_INCIDENT_CAPACITY = u32(16u);// Q30
const u32 EDGE_STATE_FIELDS = u32(17u);
const u32 EDGE_HOST_FIELDS = u32(3u);     // EV_RAIN .. EV_FLAGS

const u32 STATE_CLOSED = u32(1u);
const u32 STATE_INCIDENT_CLOSED = u32(2u);
const u32 STATE_FLOOD_TRANSITION = u32(4u);

// Inputs: per-edge controls and couplings, per-node signal overrides, and
// per-signal phases. Written by the host, read by the step.
const u32 IN_MANUAL_SPEED = u32(0u);      // Q30, [0, 2]
const u32 IN_MANUAL_CAPACITY = u32(1u);   // Q30, [0, 2]
const u32 IN_MANUAL_CLOSED = u32(2u);     // 0 or 1
const u32 IN_INCIDENT_SPEED = u32(3u);    // Q30
const u32 IN_INCIDENT_CAPACITY = u32(4u); // Q30
const u32 IN_INCIDENT_CLOSED = u32(5u);   // 0 or 1
const u32 IN_ATTRACTION = u32(6u);        // Q28 signed
// The coupled environment's view of the road: multipliers from grade, wind
// and standing water (vehicle dynamics), a closure for water too deep to
// drive through, and a flood index for the road's state. 1, 1, 0, 0 when no
// environment is coupled, which leaves the step exactly as before.
const u32 IN_ENV_SPEED = u32(7u);         // Q30
const u32 IN_ENV_CAPACITY = u32(8u);      // Q30
const u32 IN_ENV_CLOSED = u32(9u);        // 0 or 1
const u32 IN_ENV_FLOOD = u32(10u);        // Q30, 0..1
const u32 EDGE_INPUT_FIELDS = u32(11u);
// After the edge fields: node overrides (node stride), then signal phases.

// Step parameters: a fixed header, then the active storms and surges.
const u32 P_VIRTUAL_S = u32(0u);
const u32 P_DT = u32(1u);
const u32 P_MODULES = u32(2u);
const u32 P_DAY = u32(3u);                // Q30 diurnal profile
const u32 P_NODE_COUNT = u32(4u);
const u32 P_EDGE_COUNT = u32(5u);
const u32 P_NODE_STRIDE = u32(6u);
const u32 P_EDGE_STRIDE = u32(7u);
const u32 P_SIGNAL_COUNT = u32(8u);
const u32 P_STORM_COUNT = u32(9u);
const u32 P_SURGE_COUNT = u32(10u);
const u32 P_SIGNAL_STRIDE = u32(11u);
const u32 P_HEADER_WORDS = u32(16u);
const u32 STORM_WORDS = u32(4u);          // x, y (POS), radius (POS), intensity (Q30)
const u32 SURGE_WORDS = u32(4u);          // x, y (POS), radius (POS), factor (Q16)

const u32 MOD_TRAFFIC = u32(1u);
const u32 MOD_SIGNALS = u32(2u);
const u32 MOD_BUILDINGS = u32(4u);
const u32 MOD_FLOODING = u32(8u);
// Standing water comes from the surface-water model through IN_ENV_*: the
// edge's flood is IN_ENV_FLOOD, closure is IN_ENV_CLOSED, and the node flood
// model's speed and capacity factors are not applied (the environment's
// multipliers already carry the water's effect).
const u32 MOD_ENVIRONMENT = u32(16u);

// --- Arithmetic helpers -------------------------------------------------------

DSTNS_FN u64 umin64(u64 a, u64 b) { return a < b ? a : b; }
DSTNS_FN u64 umax64(u64 a, u64 b) { return a > b ? a : b; }

// a * b / 2^30 for a < 2^34 and any b < 2^64, exactly (floor). Splitting b
// keeps both partial products inside 64 bits.
DSTNS_FN u64 mul_q30_wide(u64 a, u64 b) {
    return a * (b >> u64(30u)) + ((a * (b & (Q30_ONE - u64(1u)))) >> u64(30u));
}

// floor(sqrt(v)), bit by bit; exact for every 64-bit input.
DSTNS_FN u64 isqrt64(u64 v) {
    u64 result = u64(0u);
    u64 bit = u64(1u) << u64(62u);
    while (bit > v) bit = bit >> u64(2u);
    while (bit != u64(0u)) {
        if (v >= result + bit) {
            v = v - (result + bit);
            result = (result >> u64(1u)) + bit;
        } else {
            result = result >> u64(1u);
        }
        bit = bit >> u64(2u);
    }
    return result;
}

DSTNS_FN u64 abs_diff(i64 a, i64 b) { return a >= b ? u64(a - b) : u64(b - a); }

// --- Weather ------------------------------------------------------------------

// (1 - I * W(d / r)) in Q30, where W is the Wendland C2 kernel
// (1 - q)^4 (1 + 4q). Positions and radius are POS units. A storm at or beyond
// its radius contributes nothing (factor 1).
DSTNS_FN u64 storm_factor(i64 node_x, i64 node_y, i64 centre_x, i64 centre_y, u64 radius, u64 intensity) {
    u64 dx = abs_diff(node_x, centre_x);
    u64 dy = abs_diff(node_y, centre_y);
    u64 d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius) return Q30_ONE;
    // q = d / r in Q30. Inside 2^23 POS units (32 km) the distance is resolved
    // to 1/256 of a POS unit; beyond it, to one unit.
    u64 q;
    if (d2 < (u64(1u) << u64(46u))) {
        u64 fine = isqrt64(d2 << u64(16u));
        q = (fine << u64(30u)) / (radius << u64(8u));
    } else {
        q = (isqrt64(d2) << u64(30u)) / radius;
    }
    q = umin64(q, Q30_ONE);
    u64 t = Q30_ONE - q;
    u64 t2 = (t * t) >> u64(30u);
    u64 t4 = (t2 * t2) >> u64(30u);
    u64 w = (t4 * (Q30_ONE + u64(4u) * q)) >> u64(30u);
    u64 x = (umin64(intensity, Q30_ONE) * w) >> u64(30u);
    return Q30_ONE - umin64(x, Q30_ONE);
}

// Storms combine as independent probabilities: rain = 1 - prod(1 - I_k W_k).
// The running product starts at Q30_ONE and is folded in storm order.
DSTNS_FN u64 combine_rain(u64 dry, u64 factor) { return (dry * factor) >> u64(30u); }

DSTNS_FN u64 flood_step(u64 flood, u64 rain, u64 susceptibility, u64 drainage, u64 dt, bool flooding) {
    if (!flooding) return u64(0u);
    u64 gain = (((K_RAIN_FLOOD_GAIN * rain) >> u64(30u)) * susceptibility) >> u64(30u);
    u64 drain = (((K_FLOOD_DRAINAGE * drainage) >> u64(30u)) * flood) >> u64(30u);
    i64 next = i64(flood) + i64(dt * gain) - i64(dt * drain);
    if (next < i64(0)) return u64(0u);
    return umin64(u64(next), Q30_ONE);
}

// --- Traffic ------------------------------------------------------------------

DSTNS_FN bool surge_reaches(i64 from_x, i64 from_y, i64 to_x, i64 to_y, i64 centre_x, i64 centre_y, u64 radius) {
    u64 r2 = radius * radius;
    u64 ax = abs_diff(from_x, centre_x);
    u64 ay = abs_diff(from_y, centre_y);
    u64 bx = abs_diff(to_x, centre_x);
    u64 by = abs_diff(to_y, centre_y);
    return ax * ax + ay * ay <= r2 || bx * bx + by * by <= r2;
}

// Signal multiplier for an edge entering a junction. An operator override
// (1: north-south green, 2: east-west green) replaces the timing plan.
DSTNS_FN u64 signal_factor(bool signals_enabled, bool has_plan, u32 phase, bool group_a, u32 override_code) {
    if (!signals_enabled) return Q30_ONE;
    if (override_code != u32(0u)) return (group_a == (override_code == u32(1u))) ? Q30_ONE : K_SIGNAL_RED;
    if (!has_plan) return Q30_ONE;
    if ((group_a && phase == u32(0u)) || (!group_a && phase == u32(3u))) return Q30_ONE;
    if ((group_a && phase == u32(1u)) || (!group_a && phase == u32(4u))) return K_SIGNAL_AMBER;
    return K_SIGNAL_RED;
}

// Environmental multipliers of an edge, from its rain and flood (Q30).
DSTNS_FN u64 rain_speed_factor(u64 rain) { return Q30_ONE - ((K_RAIN_SPEED * rain) >> u64(30u)); }
DSTNS_FN u64 flood_speed_factor(u64 flood) { return umax64(K_FLOOD_SPEED_FLOOR, Q30_ONE - ((K_FLOOD_SPEED * flood) >> u64(30u))); }
DSTNS_FN u64 rain_capacity_factor(u64 rain) { return Q30_ONE - ((K_RAIN_CAPACITY * rain) >> u64(30u)); }
DSTNS_FN u64 flood_capacity_factor(u64 flood) { return umax64(K_FLOOD_CAPACITY_FLOOR, Q30_ONE - ((K_FLOOD_CAPACITY * flood) >> u64(30u))); }

// The edge's constants, controls and state are held as 32-bit words, as
// they are stored, and widened to 64 bits only inside the products that need
// it. Holding them as 64-bit values doubled the registers a GPU thread needs
// for no gain in range.
struct EdgeConstants {
    u32 flags;
    u32 free_speed;
    u32 free_floor;
    u32 base_capacity;
    u32 hotspot;
    u32 queue_capacity;
    u32 congestion_scale;
    u32 occupancy_scale;
    u32 baseline_coef;
    u32 lanes;
};

struct EdgeControls {
    u32 manual_speed;
    u32 manual_capacity;
    bool manual_closed;
    u32 incident_speed;
    u32 incident_capacity;
    bool incident_closed;
    u32 env_speed;
    u32 env_capacity;
    bool env_closed;
    u32 env_flood;
};

struct EdgeValues {
    u32 rain;
    u32 flood;
    u32 flags;
    i64 demand;
    u32 capacity;
    u32 speed;
    u32 load;
    u32 mean_speed;
    u32 count;
    u32 halting;
    u32 congestion_model;
    u32 congestion_observed;
    u32 congestion;
    u32 occupancy;
    u32 signal;
    u32 incident_speed;
    u32 incident_capacity;
};

// One second of edge dynamics: environment from the endpoints, then demand,
// speed and queue. `previous` is the committed state; the result replaces it.
// `surge` is the strongest active surge reaching the edge (Q16, 1.0 if none)
// and `signal` the multiplier from signal_factor.
DSTNS_FN EdgeValues edge_step(EdgeConstants s, EdgeValues previous, u64 rain_from, u64 rain_to,
                              u64 flood_from, u64 flood_to, EdgeControls c, i64 attraction,
                              u64 surge, u64 signal, u64 dt, u64 day, u32 modules) {
    EdgeValues o = previous;
    bool coupled = (modules & MOD_ENVIRONMENT) != u32(0u);
    u64 rain = (rain_from + rain_to) >> u64(1u);
    u64 flood = coupled ? u64(c.env_flood) : (flood_from + flood_to) >> u64(1u);
    o.rain = u32(rain);
    o.flood = u32(flood);
    o.incident_speed = c.incident_speed;
    o.incident_capacity = c.incident_capacity;

    bool allowed = (s.flags & EDGE_ALLOWED) != u32(0u);
    u32 flags = previous.flags & ~(STATE_FLOOD_TRANSITION | STATE_INCIDENT_CLOSED);
    if (c.incident_closed) flags = flags | STATE_INCIDENT_CLOSED;
    bool was_flooded = u64(previous.flood) > FLOOD_EVENT_Q30;
    bool now_flooded = flood > FLOOD_EVENT_Q30;
    if (allowed && was_flooded != now_flooded) flags = flags | STATE_FLOOD_TRANSITION;

    if (!allowed) {
        // Not a traversable direction: no traffic. Its closure stays as an
        // override last set it, and its signal multiplier is never evaluated.
        o.flags = flags;
        o.demand = i64(0);
        o.capacity = u32(0u);
        o.speed = u32(0u);
        o.load = u32(0u);
        o.mean_speed = u32(0u);
        o.count = u32(0u);
        o.halting = u32(0u);
        o.congestion_model = u32(0u);
        o.congestion_observed = u32(0u);
        o.congestion = u32(0u);
        o.occupancy = u32(0u);
        return o;
    }

    bool traffic = (modules & MOD_TRAFFIC) != u32(0u);
    i64 places = (modules & MOD_BUILDINGS) != u32(0u) ? attraction : i64(0);
    u64 hot = traffic ? u64(s.hotspot) : u64(0u);

    // Demand: a share of capacity driven by the time of day, nearby places and
    // hotspots, scaled by any surge.
    i64 factor = i64(K_DEMAND_BASE) + i64((K_DEMAND_DAY * day) >> u64(30u))
               + ((i64(K_DEMAND_PLACES) * places) >> u64(28u)) + i64((K_DEMAND_HOTSPOT * hot) >> u64(30u));
    i64 demand = i64(0);
    if (traffic) {
        demand = (i64(s.base_capacity) * factor) >> u64(30u);
        demand = (demand * i64(surge)) >> u64(16u);
    }

    u64 rain_speed = rain_speed_factor(rain);
    u64 flood_speed = coupled ? Q30_ONE : flood_speed_factor(flood);
    u64 rain_capacity = rain_capacity_factor(rain);
    u64 flood_capacity = coupled ? Q30_ONE : flood_capacity_factor(flood);

    bool closed = c.manual_closed || c.incident_closed || (coupled ? c.env_closed : flood >= FLOOD_CLOSED_Q30);

    // Speed relaxes towards its target at bounded acceleration and braking.
    u64 target_speed = u64(0u);
    if (!closed) {
        target_speed = (u64(s.free_speed) * signal) >> u64(30u);
        target_speed = (target_speed * rain_speed) >> u64(30u);
        target_speed = (target_speed * flood_speed) >> u64(30u);
        target_speed = (target_speed * u64(c.manual_speed)) >> u64(30u);
        target_speed = (target_speed * u64(c.incident_speed)) >> u64(30u);
        target_speed = (target_speed * u64(c.env_speed)) >> u64(30u);
    }
    u64 speed = u64(previous.speed);
    u64 acceleration = K_ACCELERATION_Q16 * dt;
    u64 deceleration = K_DECELERATION_Q16 * dt;
    if (speed < target_speed) {
        speed = umin64(target_speed, speed + acceleration);
    } else if (speed > target_speed) {
        speed = speed > target_speed + deceleration ? speed - deceleration : target_speed;
    }

    u64 capacity = u64(s.base_capacity);
    capacity = (capacity * signal) >> u64(30u);
    capacity = (capacity * rain_capacity) >> u64(30u);
    capacity = (capacity * flood_capacity) >> u64(30u);
    capacity = (capacity * u64(c.manual_capacity)) >> u64(30u);
    capacity = (capacity * u64(c.incident_capacity)) >> u64(30u);
    capacity = (capacity * u64(c.env_capacity)) >> u64(30u);

    // Queue: the load relaxes towards a target set by demand and signal delay,
    // filling at the inflow rate and draining at the lanes' discharge rate.
    u64 queue_capacity = u64(s.queue_capacity);
    u64 target_load = u64(0u);
    if (!closed) {
        i64 baseline = (demand * i64(s.baseline_coef)) >> u64(16u);
        if (baseline > i64(0)) {
            u64 delay = (K_SIGNAL_QUEUE * (Q30_ONE - signal)) >> u64(30u);
            u64 spread = u64(32768u) + (surge >> u64(1u));
            u64 amplification = Q30_ONE + ((delay * spread) >> u64(16u));
            u64 base = u64(baseline);
            target_load = base >= queue_capacity ? queue_capacity
                                                 : umin64(queue_capacity, mul_q30_wide(base, amplification));
        }
    }
    u64 load = u64(previous.load);
    if (target_load > load) {
        u64 inflow = demand > i64(0) ? (u64(demand) * dt * u64(256u)) / u64(3600u) : u64(0u);
        load = umin64(target_load, load + umax64(K_MIN_INFLOW_Q16, inflow));
    } else if (target_load < load) {
        u64 discharge = umax64(K_MIN_DISCHARGE_Q16, u64(s.lanes) * dt * K_LANE_DISCHARGE_Q16);
        load = load > target_load + discharge ? load - discharge : target_load;
    }

    u64 count = (load + u64(32768u)) >> u64(16u);
    u64 count_q16 = count << u64(16u);
    u64 congestion_scale = u64(s.congestion_scale);
    u64 congestion_model = count_q16 >= congestion_scale ? Q30_ONE : (count_q16 << u64(30u)) / congestion_scale;
    u64 mean_speed = (speed * (Q30_ONE - ((K_QUEUE_SLOWDOWN * congestion_model) >> u64(30u)))) >> u64(30u);
    u64 halting = (count * (Q30_ONE - ((K_SIGNAL_HALTING * signal) >> u64(30u))) + (u64(1u) << u64(29u))) >> u64(30u);
    u64 occupancy_q8 = (count * u64(5u)) << u64(8u);
    u64 occupancy_scale = u64(s.occupancy_scale);
    u64 occupancy = occupancy_q8 >= occupancy_scale ? Q30_ONE : (occupancy_q8 << u64(30u)) / occupancy_scale;

    u64 relative = (mean_speed << u64(30u)) / umax64(K_SPEED_FLOOR_Q16, speed);
    u64 slowdown = relative >= Q30_ONE ? u64(0u) : Q30_ONE - relative;
    u64 queue_ratio = (halting << u64(30u)) / umax64(u64(1u), count);
    u64 clear = Q30_ONE - slowdown;
    clear = (clear * (Q30_ONE - umin64(queue_ratio, Q30_ONE))) >> u64(30u);
    clear = (clear * (Q30_ONE - occupancy)) >> u64(30u);
    u64 congestion_observed = Q30_ONE - clear;

    u64 speed_loss = u64(0u);
    if (count != u64(0u)) {
        u64 free_relative = (mean_speed << u64(30u)) / u64(s.free_floor);
        speed_loss = free_relative >= Q30_ONE ? u64(0u) : Q30_ONE - free_relative;
    }
    u64 congestion = Q30_ONE;
    if (!closed) {
        congestion = umin64(Q30_ONE, (K_SPEED_LOSS_WEIGHT * speed_loss + K_QUEUE_WEIGHT * umin64(queue_ratio, Q30_ONE)
                                      + K_OCCUPANCY_WEIGHT * occupancy) >> u64(30u));
    }

    flags = closed ? (flags | STATE_CLOSED) : (flags & ~STATE_CLOSED);
    o.flags = flags;
    o.demand = demand;
    o.capacity = u32(capacity);
    o.speed = u32(speed);
    o.load = u32(load);
    o.mean_speed = u32(mean_speed);
    o.count = u32(count);
    o.halting = u32(halting);
    o.congestion_model = u32(congestion_model);
    o.congestion_observed = u32(congestion_observed);
    o.congestion = u32(congestion);
    o.occupancy = u32(occupancy);
    o.signal = u32(signal);
    return o;
}

// The congestion index sums weight * congestion over traversable edges. The
// congestion is reduced to Q16 first so a million edges cannot overflow 64 bits.
DSTNS_FN u64 congestion_contribution(u32 edge_flags, u64 weight, u64 congestion) {
    return (edge_flags & EDGE_ALLOWED) != u32(0u) ? weight * (congestion >> u64(14u)) : u64(0u);
}
