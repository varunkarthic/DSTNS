// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Surface water: the 2D shallow-water equations in their local-inertial form
// (Bates, Horritt and Fewtrell 2010, the LISFLOOD-FP scheme), written once for
// every compute backend under the rules of dstns_physics.h: integers only,
// explicit conversions, values in and values out, signed values never divided.
//
// Mass is exactly conserved. Water moves only as an integer amount taken from
// one cell and given to its neighbour, computed identically by both, so the
// sum of every cell's depth changes only by what the sources add and remove
// and what leaves through the boundary. The CPU and every GPU execute the same
// operations and so produce the same bits.
//
// Formats:
//   Z   terrain elevation, Q16 metres, signed        (+-32,768 m)
//   H   water depth, Q24 metres, signed storage, >= 0 (0 to 128 m, 6e-8 m)
//   Q   unit discharge, Q20 m^2/s, signed            (+-2,048 m^2/s)
//
// Grid: W x H cells, row major. Faces between cells in x: (W + 1) per row,
// face i of row j lies west of cell i (face W is the east boundary). Faces in
// y: (H + 1) rows of W, face row j lies south of cell row j.

// --- Scales and limits ------------------------------------------------------------

const i64 HYD_Q24_ONE = i64(16777216);
const i64 HYD_FLOW_DEPTH_MAX = i64(1677721600);   // 100 m: deeper water is clamped in the flux
const i64 HYD_FRICTION_DEPTH_MAX = i64(1966080);  // 30 m in Q16: friction is negligible beyond
const i64 HYD_DETA_MAX = i64(838860800);          // 50 m of surface difference across one face
const i64 HYD_Q_MAX = i64(67108864);              // 64 m^2/s
const u64 HYD_T_MAX = u64(1u) << u64(40u);        // friction factor cap, 2^40 in Q16

// Cell flags.
const u32 HYD_SEA = u32(1u);                      // open water: a sink to the sea

// --- Arithmetic ----------------------------------------------------------------------

DSTNS_FN i64 hyd_min(i64 a, i64 b) { return a < b ? a : b; }
DSTNS_FN i64 hyd_max(i64 a, i64 b) { return a > b ? a : b; }
DSTNS_FN i64 hyd_abs(i64 a) { return a < i64(0) ? -a : a; }

// floor(cbrt(v)) for v < 2^63, by bisection over the 21 bits a cube root can need.
DSTNS_FN u64 hyd_icbrt(u64 v) {
    u64 lo = u64(0u);
    u64 hi = u64(2097152u);
    while (lo < hi) {
        u64 mid = (lo + hi + u64(1u)) >> u64(1u);
        if (mid * mid * mid <= v) lo = mid; else hi = mid - u64(1u);
    }
    return lo;
}

// --- The flux across one face ----------------------------------------------------------

// The weighted discharge of de Almeida et al. (2012): theta q + (1 - theta)/2
// (q_before + q_after), the face's own discharge blended with its two
// neighbours along the same direction. It damps the checkerboard instability
// the plain inertial scheme shows at low friction. theta in Q16; 1 is the
// unweighted scheme of Bates et al. (2010).
DSTNS_FN i64 hyd_centred(i64 q, i64 before, i64 after, i64 theta_q16) {
    i64 rest = i64(65536) - theta_q16;
    i64 own = hyd_abs(q) * theta_q16;
    i64 mix = hyd_abs(before + after) * rest;
    i64 a = (q < i64(0) ? -own : own);
    i64 b = (before + after < i64(0) ? -mix : mix);
    // (a + b / 2) / 65536, formed as a magnitude so the shift is of a non-negative value.
    i64 sum = i64(2) * a + b;
    i64 m = hyd_abs(sum) >> i64(17);
    return sum < i64(0) ? -m : m;
}

// The new unit discharge across a face from the cell on its low side (west or
// south, "l") to the cell on its high side (east or north, "r"), positive
// towards "r":
//
//   q' = (q_c - g h_f dt (eta_r - eta_l) / dx) / (1 + g dt n^2 |q| / h_f^(7/3))
//
// q_c is the weighted discharge (hyd_centred); the friction uses the face's own q.
// h_f is the depth of water that can flow, max(eta) - max(z). A face carrying
// less than `hmin` passes nothing: the wet/dry treatment.
//
//   a_q20   g dt / dx      in Q20
//   k_q32   g dt n^2       in Q32
DSTNS_FN i64 hyd_face_flux(i64 q, i64 qc, i64 zl, i64 hl, i64 zr, i64 hr, i64 a_q20, i64 k_q32, i64 hmin) {
    i64 eta_l = zl + hl;
    i64 eta_r = zr + hr;
    i64 hf = hyd_max(eta_l, eta_r) - hyd_max(zl, zr);
    if (hf <= hmin) return i64(0);
    hf = hyd_min(hf, HYD_FLOW_DEPTH_MAX);
    i64 deta = eta_r - eta_l;
    deta = hyd_max(-HYD_DETA_MAX, hyd_min(HYD_DETA_MAX, deta));
    // g h_f dt d(eta)/dx, in Q20 m^2/s. Products are formed as magnitudes so
    // every shift is of a non-negative value, then the sign is restored.
    i64 mag = (hf * hyd_abs(deta)) >> i64(24);        // Q24 m^2
    mag = (mag * a_q20) >> i64(24);                   // Q20 m^2/s
    i64 gravity = deta < i64(0) ? -mag : mag;
    i64 num = qc - gravity;

    // Friction: h_f^(7/3) = h^2 h^(1/3) in Q48 from h in Q16.
    i64 h16 = hyd_min(hf >> i64(8), HYD_FRICTION_DEPTH_MAX);
    if (h16 <= i64(0)) return i64(0);
    u64 hu = u64(h16);
    u64 r48 = hu * hu * hyd_icbrt(hu << u64(32u));
    if (r48 == u64(0u)) return i64(0);
    u64 aq = u64(hyd_min(hyd_abs(q), HYD_Q_MAX));
    // g dt n^2 |q| / h^(7/3) in Q16: Q32 x Q20 / Q48 needs 12 more bits. With
    // k < 2^29 and |q| < 2^26 the product fits 64 bits but its shift may not,
    // so a large product is divided first (it has bits to spare).
    u64 p = u64(k_q32) * aq;
    u64 t16 = HYD_T_MAX;
    if (p < (u64(1u) << u64(51u))) {
        t16 = (p << u64(12u)) / r48;
    } else {
        u64 d = p / r48;
        if (d < (HYD_T_MAX >> u64(12u))) t16 = d << u64(12u);
    }
    if (t16 > HYD_T_MAX) t16 = HYD_T_MAX;
    u64 den = u64(65536u) + t16;
    u64 quot = (u64(hyd_abs(num)) << u64(16u)) / den;
    i64 qn = i64(quot);
    qn = hyd_min(qn, HYD_Q_MAX);
    return num < i64(0) ? -qn : qn;
}

// The depth (Q24) a discharge moves across a face in one step: |q| dt / dx.
//   c_q24   dt / dx        in Q24
DSTNS_FN i64 hyd_transfer(i64 q, i64 c_q24) {
    return (hyd_abs(q) * c_q24) >> i64(20);
}

// The share (Q16) of each outgoing transfer a cell can honour: all of it, or
// what it holds divided by what is asked of it.
DSTNS_FN i64 hyd_limiter(i64 h, i64 outgoing) {
    if (outgoing <= h || outgoing <= i64(0)) return i64(65536);
    return (h << i64(16)) / outgoing;
}

// A transfer after the donor's limiter.
DSTNS_FN i64 hyd_limited(i64 transfer, i64 limiter) { return (transfer * limiter) >> i64(16); }

// A discharge after its donor's limiter, so momentum agrees with what moved.
DSTNS_FN i64 hyd_scaled(i64 q, i64 limiter) {
    i64 m = (hyd_abs(q) * limiter) >> i64(16);
    return q < i64(0) ? -m : m;
}
