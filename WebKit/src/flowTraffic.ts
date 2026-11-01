// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { Point, TopologyEdge } from "./types";

/**
 * How the map draws traffic.
 *
 * The core's traffic model is aggregate: it knows how many vehicles are on a road and how
 * fast they are going, not who they are. These are markers standing for those figures,
 * and nothing here feeds back into the simulation. They follow the shape of the road,
 * carry on through junctions rather than vanishing at the end of an edge, keep their
 * distance from the one ahead, and stop where the core says a signal is red. A marker only
 * fades out when there are too many for what the core reports, or nowhere to go.
 */

export interface RoadFlow {
  /** Vehicles the core reports on this road. */
  count: number;
  /** Their mean speed, in metres a second. */
  speed: number;
  /** The core's signal multiplier: 1 on green, low on red. */
  signal: number;
  closed: boolean;
}

export interface Marker {
  edge: number;
  /** Metres along the edge. */
  s: number;
  v: number;
  next: number | null;
  alpha: number;
  leaving: boolean;
  braking: boolean;
  angle: number;
  x: number;
  y: number;
}

const LENGTH = 4.6; // A vehicle, in metres.
const GAP = 2.2; // What it leaves behind the one ahead, at rest.
const HEADWAY = 1.1; // Seconds it keeps behind the one ahead, moving.
const ACCELERATE = 2.2;
const BRAKE = 4.5;
const STOP_BEFORE = 3; // Metres short of the junction at a red light.
const RED = 0.3; // Below this signal multiplier a road is held.
const FADE_S = 0.4;
const STEP_S = 0.25; // The longest simulated step, so a fast rate cannot jump a queue.
const MAX_PER_ROAD = 12;
const SPAWNS_PER_FRAME = 40;

export class FlowTraffic {
  readonly markers: Marker[] = [];
  private readonly lengths = new Map<number, number[]>();
  private readonly leaving = new Map<number, TopologyEdge[]>();
  private readonly byEdge = new Map<number, Marker[]>();

  constructor(
    private readonly edges: readonly TopologyEdge[],
    private readonly random: () => number = Math.random,
  ) {
    for (const edge of edges) {
      if (edge.synthetic_reverse || edge.geometry.length < 2) continue;
      const out = this.leaving.get(edge.from);
      if (out) out.push(edge);
      else this.leaving.set(edge.from, [edge]);
    }
  }

  private cumulative(edge: TopologyEdge): number[] {
    let known = this.lengths.get(edge.id);
    if (!known) {
      known = [0];
      for (let i = 1; i < edge.geometry.length; i++) {
        known.push(known[i - 1] + Math.hypot(edge.geometry[i].x_m - edge.geometry[i - 1].x_m, edge.geometry[i].y_m - edge.geometry[i - 1].y_m));
      }
      this.lengths.set(edge.id, known);
    }
    return known;
  }

  private lengthOf(edge: TopologyEdge): number {
    const known = this.cumulative(edge);
    return known[known.length - 1];
  }

  /** The way this edge leaves its last junction, for choosing the straightest way on. */
  private bearing(points: readonly Point[], atEnd: boolean): number {
    const [a, b] = atEnd ? [points[points.length - 2], points[points.length - 1]] : [points[0], points[1]];
    return Math.atan2(b.y_m - a.y_m, b.x_m - a.x_m);
  }

  /** Where to go after this road: busier roads and straighter ways are more likely. */
  private chooseNext(edge: TopologyEdge, flows: ReadonlyMap<number, RoadFlow>): number | null {
    const options = this.leaving.get(edge.to);
    if (!options?.length) return null;
    const out = this.bearing(edge.geometry, true);
    let total = 0;
    const weights = options.map((option) => {
      const flow = flows.get(option.id);
      if (flow?.closed) return 0;
      // Turning back the way it came is only for when there is nothing else.
      if (option.id === edge.reverse_twin) return options.length === 1 ? 1 : 0.001;
      const turn = Math.cos(this.bearing(option.geometry, false) - out);
      const weight = ((flow?.count ?? 0) + 0.4) * (0.15 + (1 + turn) ** 2);
      total += weight;
      return weight;
    });
    if (!total) total = weights.reduce((a, b) => a + b, 0);
    if (!total) return null;
    let pick = this.random() * total;
    for (let i = 0; i < options.length; i++) {
      pick -= weights[i];
      if (pick <= 0 && weights[i] > 0) return options[i].id;
    }
    return options[options.length - 1].id;
  }

  /** How many markers each visible road should have, busiest first, within the budget. */
  private wanted(flows: ReadonlyMap<number, RoadFlow>, visible: (edge: TopologyEdge) => boolean, budget: number): Map<number, number> {
    const roads: { id: number; count: number; room: number }[] = [];
    for (const [id, flow] of flows) {
      if (!flow.count || flow.closed) continue;
      const edge = this.edges[id];
      if (!edge || edge.synthetic_reverse || edge.geometry.length < 2 || !visible(edge)) continue;
      roads.push({ id, count: flow.count, room: Math.max(1, Math.floor(this.lengthOf(edge) / (LENGTH + GAP + 1.2))) });
    }
    roads.sort((a, b) => b.count - a.count);
    const want = new Map<number, number>();
    let left = budget;
    for (const road of roads) {
      if (left <= 0) break;
      const n = Math.min(MAX_PER_ROAD, road.room, road.count, left);
      want.set(road.id, n);
      left -= n;
    }
    return want;
  }

  /**
   * Advance by `seconds` of simulated time and `realSeconds` of wall clock. Fades run on the
   * wall clock, so that they look the same at any speed. While paused, pass zero for both.
   */
  step(seconds: number, realSeconds: number, flows: ReadonlyMap<number, RoadFlow>, visible: (edge: TopologyEdge) => boolean, budget: number): void {
    this.byEdge.clear();
    for (const marker of this.markers) {
      const list = this.byEdge.get(marker.edge);
      if (list) list.push(marker);
      else this.byEdge.set(marker.edge, [marker]);
    }
    for (const list of this.byEdge.values()) list.sort((a, b) => b.s - a.s);

    // Match the numbers: what is too many fades, from the back; what is missing fades in.
    const want = this.wanted(flows, visible, budget);
    let total = 0;
    for (const list of this.byEdge.values()) for (const marker of list) if (!marker.leaving) total++;
    for (const [id, list] of this.byEdge) {
      const limit = (want.get(id) ?? 0) + 1;
      let staying = 0;
      for (const marker of list) if (!marker.leaving && ++staying > limit) {
        marker.leaving = true;
        total--;
      }
    }
    let spawned = 0;
    for (const [id, n] of want) {
      if (spawned >= SPAWNS_PER_FRAME || total >= budget) break;
      const edge = this.edges[id];
      const length = this.lengthOf(edge);
      let list = this.byEdge.get(id);
      if (!list) this.byEdge.set(id, (list = []));
      let have = 0;
      for (const marker of list) if (!marker.leaving) have++;
      for (; have < n && spawned < SPAWNS_PER_FRAME && total < budget; have++, spawned++, total++) {
        const s = this.freeSpot(list, length);
        if (s === null) break;
        const flow = flows.get(id)!;
        const marker: Marker = { edge: id, s, v: Math.max(0, flow.speed), next: this.chooseNext(edge, flows), alpha: 0, leaving: false, braking: false, angle: NaN, x: 0, y: 0 };
        this.markers.push(marker);
        list.push(marker);
        list.sort((a, b) => b.s - a.s);
      }
    }

    // Drive. A large step is split, so that a high playback rate keeps its queues.
    const steps = Math.max(1, Math.min(8, Math.ceil(seconds / STEP_S)));
    if (seconds > 0) for (let n = 0; n < steps; n++) this.drive(seconds / steps, flows);

    // Fade, and put each on the map.
    const fade = realSeconds / FADE_S;
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const marker = this.markers[i];
      const edge = this.edges[marker.edge];
      const seen = visible(edge);
      if (!seen) marker.leaving = true;
      marker.alpha = Math.min(1, Math.max(0, marker.alpha + (marker.leaving ? -fade : fade)));
      if (marker.leaving && (marker.alpha <= 0 || !seen)) {
        this.markers.splice(i, 1);
        continue;
      }
      this.place(marker, edge, realSeconds);
    }
  }

  private freeSpot(list: readonly Marker[], length: number): number | null {
    for (let tries = 0; tries < 6; tries++) {
      const s = this.random() * Math.max(0, length - STOP_BEFORE);
      if (list.every((marker) => Math.abs(marker.s - s) > LENGTH + GAP)) return s;
    }
    return null;
  }

  private drive(dt: number, flows: ReadonlyMap<number, RoadFlow>): void {
    this.byEdge.clear();
    for (const marker of this.markers) {
      const list = this.byEdge.get(marker.edge);
      if (list) list.push(marker);
      else this.byEdge.set(marker.edge, [marker]);
    }
    for (const list of this.byEdge.values()) list.sort((a, b) => b.s - a.s);
    for (const [id, list] of this.byEdge) {
      const edge = this.edges[id];
      const flow = flows.get(id);
      const length = this.lengthOf(edge);
      const held = !!flow && (flow.closed || flow.signal < RED);
      const cruise = Math.max(0.8, flow?.speed ?? edge.free_speed_mps * 0.7);
      for (let i = 0; i < list.length; i++) {
        const marker = list[i];
        // The space ahead: the next marker, the stop line, or the rear of the next road's traffic.
        let room: number;
        if (i > 0) room = list[i - 1].s - marker.s - LENGTH;
        else if (held) room = length - STOP_BEFORE - marker.s;
        else {
          const ahead = marker.next === null ? undefined : this.byEdge.get(marker.next);
          const last = ahead?.[ahead.length - 1];
          room = (last ? last.s - LENGTH : 60) + length - marker.s;
        }
        // Enough room, go to cruising speed; less, ease off; too little, brake. Smooth at both ends.
        const safe = GAP + marker.v * HEADWAY;
        const free = 1 - (marker.v / cruise) ** 4;
        const crowd = room > 0 ? (safe / room) ** 2 : 100;
        const accel = Math.max(-BRAKE, Math.min(ACCELERATE, ACCELERATE * (free - crowd)));
        marker.braking = accel < -0.9 || (marker.v < 0.4 && room < safe + 1);
        marker.v = Math.max(0, marker.v + accel * dt);
        let moved = marker.v * dt;
        if (i > 0 || held) moved = Math.min(moved, Math.max(0, room - 0.2));
        marker.s += moved;
      }
      // Crossing into the next road. From the front, so the order on this one holds.
      while (list.length && list[0].s >= length) {
        const marker = list.shift()!;
        const next = marker.next === null ? null : this.edges[marker.next];
        if (!next) {
          marker.s = length;
          marker.leaving = true;
          continue;
        }
        marker.s -= length;
        marker.edge = next.id;
        marker.next = this.chooseNext(next, flows);
      }
    }
  }

  private place(marker: Marker, edge: TopologyEdge, realSeconds: number): void {
    const known = this.cumulative(edge);
    const points = edge.geometry;
    const s = Math.min(marker.s, known[known.length - 1]);
    let k = 1;
    while (k < known.length - 1 && known[k] < s) k++;
    const span = known[k] - known[k - 1] || 1;
    const t = Math.min(1, (s - known[k - 1]) / span);
    const a = points[k - 1];
    const b = points[k];
    const dx = (b.x_m - a.x_m) / span;
    const dy = (b.y_m - a.y_m) / span;
    const angle = Math.atan2(dy, dx);
    if (Number.isNaN(marker.angle)) marker.angle = angle;
    else {
      // Round a bend, rather than snapping to it.
      const turn = Math.atan2(Math.sin(angle - marker.angle), Math.cos(angle - marker.angle));
      marker.angle += turn * Math.min(1, realSeconds * 11);
    }
    marker.x = a.x_m + (b.x_m - a.x_m) * t;
    marker.y = a.y_m + (b.y_m - a.y_m) * t;
  }
}
