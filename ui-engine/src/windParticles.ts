// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Wind shown as moving streaks: particles carried by the simulated
 * near-surface wind, each leaving a short fading trail. Speed is the colour
 * of the heatmap beneath; the streaks add direction and make the flow
 * readable at a glance. Presentation only: the particles are not simulated
 * and are reseeded freely.
 */

import type { WindView } from "./types";

/** The wind at a point (metres, east and north), bilinear between lattice column centres; edges clamp. */
export function sampleWind(wind: WindView, x_m: number, y_m: number): [number, number] {
  const { width: w, height: h } = wind;
  if (!w || !h) return [0, 0];
  const fx = Math.min(w - 1, Math.max(0, (x_m - wind.origin_x_m) / wind.cell_m - 0.5));
  const fy = Math.min(h - 1, Math.max(0, (y_m - wind.origin_y_m) / wind.cell_m - 0.5));
  const i = Math.min(w - 2, Math.floor(fx)),
    j = Math.min(h - 2, Math.floor(fy));
  if (w < 2 || h < 2) return [wind.u[0] ?? 0, wind.v[0] ?? 0];
  const tx = fx - i,
    ty = fy - j;
  const at = (a: number[], ii: number, jj: number) => a[jj * w + ii] ?? 0;
  const mix = (a: number[]) =>
    (1 - ty) * ((1 - tx) * at(a, i, j) + tx * at(a, i + 1, j)) + ty * ((1 - tx) * at(a, i, j + 1) + tx * at(a, i + 1, j + 1));
  return [mix(wind.u), mix(wind.v)];
}

export interface Particle {
  x: number;
  y: number;
  age: number;
  life: number;
}

/** The lattice's extent in metres: [x0, y0, x1, y1]. */
export function windBounds(wind: WindView): [number, number, number, number] {
  return [wind.origin_x_m, wind.origin_y_m, wind.origin_x_m + wind.width * wind.cell_m, wind.origin_y_m + wind.height * wind.cell_m];
}

/** A particle somewhere inside `bounds`, with a staggered lifetime so they do not all expire together. */
export function spawn(bounds: [number, number, number, number], random: () => number = Math.random): Particle {
  const [x0, y0, x1, y1] = bounds;
  return { x: x0 + random() * (x1 - x0), y: y0 + random() * (y1 - y0), age: 0, life: 40 + random() * 80 };
}

/**
 * Advance every particle by the wind over `dt` animation seconds. `metresPerMps`
 * is how far one m/s carries a particle in one animation second, so the
 * streaks move at a readable pace whatever the zoom. Particles that leave the
 * lattice or outlive their lifetime are reseeded. Returns each particle's
 * previous position, for drawing its trail segment.
 */
export function advect(
  particles: Particle[],
  wind: WindView,
  dt: number,
  metresPerMps: number,
  random: () => number = Math.random,
): Array<[number, number]> {
  const bounds = windBounds(wind);
  const [x0, y0, x1, y1] = bounds;
  const previous: Array<[number, number]> = [];
  for (let k = 0; k < particles.length; k++) {
    const p = particles[k];
    previous.push([p.x, p.y]);
    const [u, v] = sampleWind(wind, p.x, p.y);
    p.x += u * metresPerMps * dt;
    p.y += v * metresPerMps * dt;
    p.age += 1;
    if (p.age > p.life || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) {
      particles[k] = spawn(bounds, random);
      previous[k] = [particles[k].x, particles[k].y];
    }
  }
  return previous;
}

/** How many particles to keep for a viewport of this many square pixels. */
export function particleBudget(pixels: number): number {
  return Math.round(Math.min(1400, Math.max(200, pixels / 1000)));
}
