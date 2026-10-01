// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * The place glyphs.
 *
 * Places used to be drawn as letters - H, S, U, M - which is a legend you have
 * to learn before the map means anything, and which collapses as soon as two
 * kinds share an initial. These are drawn instead.
 *
 * Path data lives here rather than in the icon set because two very different
 * renderers need it: the legend draws it as SVG in the DOM, and the map draws
 * it into a canvas through Path2D. Keeping one source means the glyph beside a
 * legend entry is provably the glyph on the map, not a lookalike.
 *
 * Every path is drawn in the icon set's 24-unit box, stroked rather than
 * filled, so it renders at the same weight as the rest of the interface.
 */

/** Strokes for one glyph, in a 24x24 box. */
export type Glyph = readonly string[];

export const PLACE_GLYPHS: Readonly<Record<string, Glyph>> = {
  // A cross: the one place symbol that needs no explaining.
  hospital: ["M12 6.5v11", "M6.5 12h11"],
  // A mortar and pestle, which a pharmacy is and a hospital is not.
  pharmacy: ["M6 10.5h12a6 6 0 01-12 0z", "M12 16.5v3", "M8.5 19.5h7", "M14 10l3.5-3.5"],
  // A graduation cap.
  school: ["M3.5 10L12 6l8.5 4-8.5 4z", "M7 12v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4"],
  // A cap with a tassel: further along than school, and distinct at a glance.
  university: ["M3.5 10L12 6l8.5 4-8.5 4z", "M7 12v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4", "M20.5 10v4.5"],
  // A tower block with windows.
  office: ["M6 20V5h12v15", "M9.5 8.5h1.5M13 8.5h1.5M9.5 12h1.5M13 12h1.5", "M10.5 20v-4h3v4"],
  // A shopping bag.
  mall: ["M6 8.5h12l-1 11.5H7z", "M9.5 8.5V7a2.5 2.5 0 015 0v1.5"],
  // A storefront under an awning.
  shops: ["M5 9.5h14V20H5z", "M4.5 9.5L6 5h12l1.5 4.5", "M10 20v-4.5h4V20"],
  // A fork and a knife.
  food: ["M8.5 5v5.5a1.8 1.8 0 003.5 0V5", "M10.2 10.5V19", "M16 5c1.6 1.2 1.6 4.8 0 6v8"],
  // A bus, seen head-on.
  transport: ["M6 6.5h12v9H6z", "M6 15.5v2.5M18 15.5v2.5", "M6 11h12", "M8.5 13.2h.8M14.7 13.2h.8"],
  // A bed.
  hotel: ["M4 18v-8", "M4 13h16v5", "M20 18v-5a3 3 0 00-3-3h-7v3", "M7 10.5V9"],
  // A classical facade: the museum and the concert hall share it.
  culture: ["M4 9.5L12 5l8 4.5", "M6.5 11v6M11 11v6M15.5 11v6", "M4.5 19.5h15"],
  // An arena: a pitch inside a ring.
  stadium: ["M3.5 12a8.5 5.5 0 1017 0 8.5 5.5 0 10-17 0z", "M8 12a4 2.5 0 108 0 4 2.5 0 10-8 0z"],
  // A place of worship: a dome and a spire, not any one faith's mark.
  worship: ["M6 20v-7a6 6 0 0112 0v7", "M4.5 20h15", "M12 7V3.5", "M10.5 5h3"],
  // A factory with a chimney.
  industrial: ["M4 20V12l5 3V12l5 3V7h6v13z", "M4.5 20h15"],
  // A tree.
  park: ["M12 20v-4", "M12 16a5 5 0 01-1.5-9.8A4 4 0 0117 8a4 4 0 01-1.5 7.8z"],
  // A car, for where you leave one.
  parking: ["M4.5 16.5V13l1.6-3.7A2 2 0 018 8h8a2 2 0 011.9 1.3L19.5 13v3.5", "M4.5 13h15", "M6.5 16.5V18M17.5 16.5V18"],
  // A house.
  residential: ["M4.5 11L12 5l7.5 6", "M6.5 10v9h11v-9", "M10.5 19v-4.5h3V19"],
};

/** The dot drawn for anything the taxonomy has no glyph for. */
export const UNCLASSIFIED_GLYPH: Glyph = ["M12 10.5a1.5 1.5 0 100 3 1.5 1.5 0 100-3z"];

export function glyphFor(kindId: string): Glyph {
  return PLACE_GLYPHS[kindId] ?? UNCLASSIFIED_GLYPH;
}

/**
 * Path2D objects for the canvas, built once and reused.
 *
 * Path2D is not available while rendering on a server or in a test environment
 * without a canvas, so this degrades to null and the caller falls back.
 */
const cache = new Map<string, Path2D[] | null>();

export function canvasGlyph(kindId: string): Path2D[] | null {
  const hit = cache.get(kindId);
  if (hit !== undefined) return hit;
  let built: Path2D[] | null = null;
  try {
    built = glyphFor(kindId).map((d) => new Path2D(d));
  } catch {
    built = null; // No Path2D here: the caller draws something simpler.
  }
  cache.set(kindId, built);
  return built;
}
