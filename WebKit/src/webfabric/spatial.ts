// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { SPRINGS, stepSpring } from "../motion";
import type { SpringPreset } from "../motion";
import type { Point, Topology } from "../types";
import type { OverlayFeature } from "./store";

/**
 * Overlay features tied to the road network. An application names junctions and
 * roads; this works out where they are in the loaded world. The server refuses what
 * does not fit the world it has, and a world replaced afterwards simply leaves out
 * whatever no longer exists.
 */

export interface Network {
  node: (id: number) => Point | undefined;
  edge: (id: number) => Point[] | undefined;
  /** The road's shape from one junction to the next, if a road runs that way. */
  between: (from: number, to: number) => Point[] | undefined;
}

export function networkOf(topology: Topology | null): Network | null {
  if (!topology) return null;
  const nodes = new Map(topology.nodes.map((n) => [n.id, n.position]));
  const edges = new Map(topology.edges.map((e) => [e.id, e]));
  const roads = new Map(topology.edges.map((e) => [`${e.from}>${e.to}`, e]));
  const shape = (e: Topology["edges"][number]) => (e.geometry.length >= 2 ? e.geometry : [nodes.get(e.from), nodes.get(e.to)].filter((p): p is Point => !!p));
  return {
    node: (id) => nodes.get(id),
    edge: (id) => {
      const e = edges.get(id);
      return e && shape(e);
    },
    between: (from, to) => {
      const e = roads.get(`${from}>${to}`);
      return e && shape(e);
    },
  };
}

/** A line with the distance to each of its points, and to each junction it passes. */
export interface Track {
  points: [number, number][];
  lengths: number[];
  stops: number[];
  total: number;
}

export function trackOf(nodes: number[], network: Network): Track | null {
  const points: [number, number][] = [];
  const stops: number[] = [0];
  for (let i = 1; i < nodes.length; i++) {
    const road = network.between(nodes[i - 1], nodes[i]);
    if (!road?.length) return null;
    for (const p of road) {
      const last = points[points.length - 1];
      if (!last || last[0] !== p.x_m || last[1] !== p.y_m) points.push([p.x_m, p.y_m]);
    }
    stops.push(points.length - 1);
  }
  if (points.length < 2) return null;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, lengths, stops: stops.map((index) => lengths[index]), total: lengths[lengths.length - 1] };
}

/** Where on a track a distance falls, and which way it faces there. */
export function along(track: Track, distance: number): { x: number; y: number; heading: number; index: number } {
  const d = Math.max(0, Math.min(track.total, distance));
  let low = 0;
  let high = track.lengths.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (track.lengths[middle] <= d) low = middle;
    else high = middle;
  }
  const [ax, ay] = track.points[low];
  const [bx, by] = track.points[high];
  const span = track.lengths[high] - track.lengths[low] || 1;
  const t = (d - track.lengths[low]) / span;
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, heading: Math.atan2(by - ay, bx - ax), index: low };
}

/**
 * Turns markers, entities and routes into positions and lines. Paths stay as they are,
 * because they move: see PathRun. What cannot be placed is left out.
 */
export function placeFeature(feature: OverlayFeature, network: Network | null): OverlayFeature | null {
  const { type } = feature;
  if (type !== "marker" && type !== "entity" && type !== "route" && type !== "path") return feature;
  if (!network) return null;
  if (type === "marker") {
    const position = typeof feature.node === "number" ? network.node(feature.node) : undefined;
    return position ? { ...feature, x_m: position.x_m, y_m: position.y_m } : null;
  }
  if (type === "entity") {
    const road = typeof feature.edge === "number" ? network.edge(feature.edge) : undefined;
    if (!road?.length) return null;
    const lengths = [0];
    for (let i = 1; i < road.length; i++) lengths.push(lengths[i - 1] + Math.hypot(road[i].x_m - road[i - 1].x_m, road[i].y_m - road[i - 1].y_m));
    const total = lengths[lengths.length - 1];
    const track: Track = { points: road.map((p) => [p.x_m, p.y_m]), lengths, stops: [], total };
    const spot = along(track, (feature.at ?? 0) * total);
    return { ...feature, x_m: spot.x, y_m: spot.y, heading: spot.heading };
  }
  const track = Array.isArray(feature.nodes) ? trackOf(feature.nodes, network) : null;
  if (!track) return null;
  return type === "route" ? { ...feature, type: "line", points: track.points } : feature;
}

const PATH_SPRINGS: Record<string, SpringPreset> = {
  smooth: SPRINGS.spatialSlow,
  standard: SPRINGS.spatialDefault,
  lively: SPRINGS.expressiveDefault,
  snappy: SPRINGS.expressiveFast,
};

export function pathSpring(spring: OverlayFeature["spring"]): SpringPreset {
  if (spring && typeof spring === "object") return { k: spring.stiffness, c: spring.damping };
  return PATH_SPRINGS[spring ?? "standard"] ?? SPRINGS.spatialDefault;
}

/**
 * One path playing. A guide travels the track at the path's speed and holds at
 * junctions; the entity follows the guide on the path's spring, so the spring is what
 * shapes how it pulls away and how it settles into each stop.
 */
export class PathRun {
  guide = 0;
  distance = 0;
  velocity = 0;
  private direction = 1;
  private hold: number;
  private nextStop = 1;
  finished = false;

  constructor(public track: Track, delay = 0) {
    this.hold = delay;
  }

  step(feature: OverlayFeature, dt: number): boolean {
    const { track } = this;
    const speed = feature.speed_mps ?? 40;
    if (!feature.paused && !this.finished) {
      if (this.hold > 0) this.hold -= dt;
      else {
        this.guide += this.direction * speed * dt;
        const dwell = feature.dwell_s ?? 0;
        // Only junctions in between hold: the ends have their own treatment.
        const stop = track.stops[this.nextStop];
        if (dwell > 0 && stop !== undefined && this.nextStop > 0 && this.nextStop < track.stops.length - 1 && (this.direction > 0 ? this.guide >= stop : this.guide <= stop)) {
          this.guide = stop;
          this.hold = dwell;
          this.nextStop += this.direction;
        }
        if (this.guide >= track.total || this.guide <= 0) this.end(feature);
      }
    }
    [this.distance, this.velocity] = stepSpring(this.distance, this.velocity, this.guide, pathSpring(feature.spring), dt);
    return !this.finished || Math.abs(this.distance - this.guide) > 0.05 || Math.abs(this.velocity) > 0.05;
  }

  private end(feature: OverlayFeature) {
    const { track } = this;
    this.guide = Math.max(0, Math.min(track.total, this.guide));
    this.hold = feature.dwell_s ?? 0;
    if (feature.bounce) {
      this.direction = this.guide > 0 ? -1 : 1;
      this.nextStop = this.direction > 0 ? 1 : track.stops.length - 2;
      if (!feature.loop && this.direction > 0) this.finished = true;
    } else if (feature.loop) {
      // Starting again is a new journey, not a very fast trip back along the road.
      this.guide = this.distance = this.velocity = 0;
      this.nextStop = 1;
    } else {
      this.finished = true;
    }
  }
}
