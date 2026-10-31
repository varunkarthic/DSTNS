// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Tooltip placement.
 *
 * A tooltip must never land on top of the control it describes, and should not
 * cover neighbouring controls or important readouts when another position
 * would work. Each side of the anchor is tried, the tooltip is slid along that
 * side to stay inside the viewport, and every candidate is scored by how much
 * it would clip or cover. The cheapest candidate wins; ties go to the
 * preferred order.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How much covering this region costs relative to others. Defaults to 1. */
  weight?: number;
}
export type Side = "top" | "bottom" | "left" | "right";

export interface PlacementInput {
  anchor: Rect;
  tip: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Regions the tooltip should avoid covering. */
  avoid?: Rect[];
  preferred?: Side[];
  /** Space between anchor and tooltip. */
  gap?: number;
  /** Minimum distance from the viewport edge. */
  margin?: number;
}

export interface Placement {
  side: Side;
  left: number;
  top: number;
  /** Arrow position along the tooltip edge facing the anchor, in pixels. */
  arrow: number;
  /** Weighted pixels of the tooltip that cover avoided regions. */
  overlap: number;
  /** Whether the tooltip fits without clipping. */
  fits: boolean;
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

function candidate(side: Side, input: Required<Omit<PlacementInput, "avoid">> & { avoid: Rect[] }): Placement & { score: number } {
  const { anchor, tip, viewport, gap, margin } = input;
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    top = side === "top" ? anchor.top - gap - tip.height : anchor.top + anchor.height + gap;
    left = clamp(cx - tip.width / 2, margin, viewport.width - margin - tip.width);
  } else {
    left = side === "left" ? anchor.left - gap - tip.width : anchor.left + anchor.width + gap;
    top = clamp(cy - tip.height / 2, margin, viewport.height - margin - tip.height);
  }
  const box = { left, top, width: tip.width, height: tip.height };
  // How much of the tooltip would fall outside the viewport.
  const inside = intersectionArea(box, {
    left: margin,
    top: margin,
    width: viewport.width - margin * 2,
    height: viewport.height - margin * 2,
  });
  const clipped = tip.width * tip.height - inside;
  const coversAnchor = intersectionArea(box, anchor);
  const overlap = input.avoid.reduce((sum, r) => sum + intersectionArea(box, r) * (r.weight ?? 1), 0);
  const arrow =
    side === "top" || side === "bottom"
      ? clamp(cx - left, 10, tip.width - 10)
      : clamp(cy - top, 10, tip.height - 10);
  // Clipping is worst, covering the anchor next, then covering neighbours.
  const score = clipped * 1000 + coversAnchor * 100 + overlap;
  return { side, left, top, arrow, overlap, fits: clipped <= 0.5, score };
}

export function computePlacement(input: PlacementInput): Placement {
  const full = {
    anchor: input.anchor,
    tip: input.tip,
    viewport: input.viewport,
    preferred: input.preferred ?? (["top", "bottom", "right", "left"] as Side[]),
    gap: input.gap ?? 8,
    margin: input.margin ?? 8,
    // A region that contains the anchor is its own container, not a neighbour.
    avoid: (input.avoid ?? []).filter(
      (r) => intersectionArea(r, input.anchor) < input.anchor.width * input.anchor.height * 0.5,
    ),
  };
  const sides = [...full.preferred, ...(["top", "bottom", "right", "left"] as Side[]).filter((s) => !full.preferred.includes(s))];
  let best: (Placement & { score: number }) | null = null;
  for (const side of sides) {
    const c = candidate(side, full);
    if (!best || c.score < best.score - 0.5) best = c;
  }
  const chosen = best!;
  // Whatever won, never leave the viewport.
  const left = clamp(chosen.left, full.margin, input.viewport.width - full.margin - input.tip.width);
  const top = clamp(chosen.top, full.margin, input.viewport.height - full.margin - input.tip.height);
  return { side: chosen.side, left, top, arrow: chosen.arrow, overlap: chosen.overlap, fits: chosen.fits };
}
