// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * What makes a map fast: never draw one thing at a time. Geometry is grouped into a
 * grid of tiles, and within a tile into one path per style, so a screenful of roads is
 * a few dozen strokes rather than thousands, and tiles off screen cost nothing.
 */

export interface TileGeometry {
  path: Path2D;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MapTile {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  batches: Map<string, Path2D>;
}

export interface MapView {
  x: number;
  y: number;
  scale: number;
}

const GRID = 8;

export function buildTiles<T>(items: readonly T[], geometry: (item: T, index: number) => TileGeometry | null, style: (item: T, index: number) => string | null): MapTile[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const placed: { g: TileGeometry; key: string }[] = [];
  items.forEach((item, index) => {
    const g = geometry(item, index);
    const key = g && style(item, index);
    if (!g || !key) return;
    placed.push({ g, key });
    minX = Math.min(minX, g.minX);
    minY = Math.min(minY, g.minY);
    maxX = Math.max(maxX, g.maxX);
    maxY = Math.max(maxY, g.maxY);
  });
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const tiles = new Map<number, MapTile>();
  for (const { g, key } of placed) {
    const column = Math.min(GRID - 1, Math.floor((((g.minX + g.maxX) / 2 - minX) / width) * GRID));
    const row = Math.min(GRID - 1, Math.floor((((g.minY + g.maxY) / 2 - minY) / height) * GRID));
    const id = row * GRID + column;
    let tile = tiles.get(id);
    if (!tile) {
      tile = { minX: g.minX, minY: g.minY, maxX: g.maxX, maxY: g.maxY, batches: new Map() };
      tiles.set(id, tile);
    }
    tile.minX = Math.min(tile.minX, g.minX);
    tile.minY = Math.min(tile.minY, g.minY);
    tile.maxX = Math.max(tile.maxX, g.maxX);
    tile.maxY = Math.max(tile.maxY, g.maxY);
    let batch = tile.batches.get(key);
    if (!batch) {
      batch = new Path2D();
      tile.batches.set(key, batch);
    }
    batch.addPath(g.path);
  }
  return [...tiles.values()];
}

export function tileOnScreen(tile: Pick<MapTile, "minX" | "minY" | "maxX" | "maxY">, view: MapView, width: number, height: number, pad = 20): boolean {
  return tile.maxX * view.scale + view.x >= -pad && tile.minX * view.scale + view.x <= width + pad && tile.maxY * view.scale + view.y >= -pad && tile.minY * view.scale + view.y <= height + pad;
}

/** How large a thing must be on screen to be worth drawing, by its size in metres. */
export function sizeTier(g: Pick<TileGeometry, "minX" | "minY" | "maxX" | "maxY">): "small" | "medium" | "large" {
  const size = Math.max(g.maxX - g.minX, g.maxY - g.minY);
  return size < 18 ? "small" : size < 60 ? "medium" : "large";
}

const TIER_METRES = { small: 12, medium: 36, large: 120 } as const;

/** Whether a tier of this size still shows as more than a speck at this zoom. */
export function tierShows(tier: keyof typeof TIER_METRES, scale: number): boolean {
  return TIER_METRES[tier] * scale >= 1.4;
}

/** How many markers and names a screen can hold before they stop helping anyone. */
export const MARKER_BUDGET = 240;
export const STREET_NAME_BUDGET = 60;
export const PLACE_NAME_BUDGET = 40;

/** Where street names begin, by how important the road is. */
export function streetNameShows(roadClass: string, scale: number): boolean {
  if (scale <= 0.3) return false;
  if (["motorway", "primary", "secondary"].includes(roadClass)) return true;
  if (roadClass === "tertiary") return scale > 0.5;
  return scale > 0.9;
}

/** Where place names begin: landmarks first, everything else once close enough. */
export function placeNameShows(landmark: boolean, scale: number): boolean {
  return landmark ? scale > 0.8 : scale > 1.4;
}
