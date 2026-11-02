// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * What applications ask of the view, and what the observer makes of it. An application asks, and
 * the observer decides. What it asks is laid over a person's choices and is never one of them:
 * nothing here writes a setting, and all of it is gone when the application is.
 */

/** Layers and places an application is holding on or off. */
export interface Held {
  app: string;
  name: string;
  revision: number;
  layers: Record<string, boolean>;
  places: Record<string, boolean>;
}

/** A request to move the map, already checked by the server. */
export interface ViewRequest {
  request: number;
  app: string;
  name: string;
  view:
    | { action: "focus"; x_m: number; y_m: number; span_m?: number }
    | { action: "node"; node: number; span_m?: number }
    | { action: "edge"; edge: number; span_m?: number }
    | { action: "bounds"; min_x_m: number; min_y_m: number; max_x_m: number; max_y_m: number }
    | { action: "zoom"; factor: number }
    | { action: "fit" };
}

export const releaseKey = (app: string, field: "layers" | "places", key: string) => `${app}/${field}/${key}`;

/**
 * What is shown, and who is holding what. Later applications win over earlier ones, so that the same
 * applications give the same result. Three things come before any application: a person who has
 * changed that same thing since it was asked for (`released`, by revision, until the application asks
 * again); and while detail is reduced under load, nothing is turned on that the person's own state
 * has off. An application can always hide more, but cannot bring back what was cut to keep up.
 */
export function heldOver<T extends object>(own: T, held: readonly Held[], field: "layers" | "places", released: ReadonlyMap<string, number>, reduced: boolean, absent = false): { shown: T; holders: Record<string, string> } {
  const mine = own as Record<string, boolean>;
  const shown: Record<string, boolean> = { ...mine };
  const holders: Record<string, string> = {};
  for (const app of held) {
    for (const [key, on] of Object.entries(app[field])) {
      if (released.get(releaseKey(app.app, field, key)) === app.revision) continue;
      if (reduced && on && !(mine[key] ?? absent)) continue;
      shown[key] = on;
      holders[key] = app.name;
    }
  }
  return { shown: shown as T, holders };
}

/** Why a request to move the map is turned down now, if it is. A person's own move holds for this long. */
export const PERSON_HOLDS_CAMERA_MS = 8000;
export function viewDeclined(now: number, personMovedAt: number, busy: string | null): string | null {
  if (busy) return busy;
  return now - personMovedAt < PERSON_HOLDS_CAMERA_MS ? "person_moved_the_map" : null;
}

export interface ViewTarget {
  whole?: boolean;
  zoomBy?: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  x_m?: number;
  y_m?: number;
  span_m?: number;
}
interface Place {
  nodes: readonly { id: number; position: { x_m: number; y_m: number } }[];
  edges: readonly { id: number; geometry: readonly { x_m: number; y_m: number }[] }[];
}

/** Where on the map a request means, or nothing if it isn't in the world on screen. */
export function viewTarget(view: ViewRequest["view"], world: Place | null): ViewTarget | null {
  switch (view.action) {
    case "fit":
      return { whole: true };
    case "zoom":
      return { zoomBy: view.factor };
    case "focus":
      return { x_m: view.x_m, y_m: view.y_m, span_m: view.span_m };
    case "bounds":
      return { bounds: { minX: view.min_x_m, maxX: view.max_x_m, minY: view.min_y_m, maxY: view.max_y_m } };
    case "node": {
      const node = world?.nodes.find((n) => n.id === view.node);
      return node ? { x_m: node.position.x_m, y_m: node.position.y_m, span_m: view.span_m } : null;
    }
    case "edge": {
      const shape = world?.edges.find((e) => e.id === view.edge)?.geometry;
      if (!shape?.length) return null;
      const [xs, ys] = [shape.map((p) => p.x_m), shape.map((p) => p.y_m)];
      const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      return view.span_m ? { x_m: (bounds.minX + bounds.maxX) / 2, y_m: (bounds.minY + bounds.maxY) / 2, span_m: view.span_m } : { bounds };
    }
  }
}

/** One of the palette's series, always the same for the same mark of the same application. */
export function autoSeries(app: string, element: string | undefined): number {
  let hash = 2166136261;
  for (const c of `${app}/${element ?? ""}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) % 8;
}

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(channels(a)), luminance(channels(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const hexOf = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * A colour an application named, as it may be drawn: moved towards white or black, as little as it
 * takes, until it can be seen on this map (3:1, the WCAG figure for graphics). With a colour vision
 * mode on, it is the nearest of the series that mode has chosen, so that a person's choice still holds.
 */
export function legibleColour(colour: string, ground: string, series?: readonly string[]): string {
  if (series?.length) {
    const rgb = channels(colour);
    const distance = (other: string) => channels(other).reduce((sum, v, i) => sum + (v - rgb[i]) ** 2, 0);
    return series.reduce((best, other) => (distance(other) < distance(best) ? other : best));
  }
  if (contrast(colour, ground) >= 3) return colour;
  const towards = luminance(channels(ground)) < 0.18 ? 255 : 0;
  const rgb = channels(colour);
  for (let step = 1; step <= 20; step++) {
    const moved = hexOf(rgb.map((v) => v + (towards - v) * (step / 20)));
    if (contrast(moved, ground) >= 3) return moved;
  }
  return towards ? "#ffffff" : "#000000";
}

/** A path's line. Canvas dashes, in pixels; `dotted` relies on the round cap. */
export function dashOf(style: string | undefined, dash?: boolean): number[] {
  if (style === "dashed") return [10, 8];
  if (style === "dotted") return [0.01, 7];
  if (style === "flow") return [12, 10];
  return dash ? [5, 6] : [];
}
