// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { jsPDF } from "jspdf";

/**
 * Still line drawings for the report's sections, in the manner of the observer's empty-state figures: isometric,
 * one hairline weight, nothing filled but a quiet face or two, and a single bright edge on what the section is about.
 * Each is drawn in a box of the given width and height, in millimetres, with vector strokes, so it prints sharp.
 */
export type Illustration =
  | "summary" | "configuration" | "environment" | "network" | "traffic" | "signals" | "weather" | "flooding"
  | "incidents" | "timeline" | "performance" | "resources" | "integrity" | "map" | "methodology";

const INK = "#9aaebb";
const FACE = "#f1f5f8";
const BRIGHT = "#0a7f9e";
const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);

type P = [number, number];

export function drawIllustration(pdf: jsPDF, name: Illustration, x: number, y: number, w: number, h: number) {
  // A 100 by 64 drawing board, scaled into the box, with the isometric origin at its middle.
  const k = Math.min(w / 100, h / 64);
  const ox = x + w / 2, oy = y + h / 2 + 6 * k;
  const iso = (a: number, b: number, z = 0): P => [ox + (a - b) * C * k, oy + (a + b) * S * k - z * k];
  const flat = (a: number, b: number): P => [ox + a * k, oy + b * k];
  const stroke = (color = INK, width = 0.22) => {
    pdf.setDrawColor(color);
    pdf.setLineWidth(width);
  };
  const path = (points: P[], closed = false, fill?: string) => {
    if (points.length < 2) return;
    const rel = points.slice(1).map((p, i) => [p[0] - points[i][0], p[1] - points[i][1]]);
    if (fill) pdf.setFillColor(fill);
    pdf.lines(rel, points[0][0], points[0][1], [1, 1], fill ? "FD" : "S", closed);
  };
  const seg = (a: P, b: P) => pdf.line(a[0], a[1], b[0], b[1]);
  const ellipse = (c: P, rx: number, ry: number, fill?: string) => {
    if (fill) pdf.setFillColor(fill);
    pdf.ellipse(c[0], c[1], rx * k, ry * k, fill ? "FD" : "S");
  };
  // A box on the floor: its three visible faces, with the top face quiet.
  const box = (a: number, b: number, z: number, da: number, db: number, dz: number, top = FACE) => {
    path([iso(a, b, z + dz), iso(a + da, b, z + dz), iso(a + da, b + db, z + dz), iso(a, b + db, z + dz)], true, top);
    path([iso(a + da, b, z), iso(a + da, b + db, z), iso(a + da, b + db, z + dz), iso(a + da, b, z + dz)], true, "#ffffff");
    path([iso(a, b + db, z), iso(a + da, b + db, z), iso(a + da, b + db, z + dz), iso(a, b + db, z + dz)], true, "#ffffff");
  };
  const floor = (r: number) => {
    stroke(INK, 0.16);
    path([iso(-r, -r), iso(r, -r), iso(r, r), iso(-r, r)], true);
  };

  pdf.saveGraphicsState?.();
  switch (name) {
    case "summary": {
      // Three slabs, the top one bright: the run, summed up.
      stroke();
      box(-22, -22, 0, 44, 44, 5);
      box(-17, -17, 7, 34, 34, 5);
      box(-12, -12, 14, 24, 24, 5);
      stroke(BRIGHT, 0.35);
      path([iso(-12, -12, 19), iso(12, -12, 19), iso(12, 12, 19), iso(-12, 12, 19)], true);
      break;
    }
    case "configuration": {
      // Three sliders on a plate, one set.
      stroke();
      box(-26, -18, 0, 52, 36, 3);
      [-10, 0, 10].forEach((b, i) => {
        stroke(INK, 0.22);
        seg(iso(-20, b, 3), iso(20, b, 3));
        const at = [-6, 9, -13][i];
        box(at - 3, b - 2, 3, 6, 4, 4, i === 1 ? "#dff2f7" : FACE);
        if (i === 1) {
          stroke(BRIGHT, 0.35);
          path([iso(at - 3, b - 2, 7), iso(at + 3, b - 2, 7), iso(at + 3, b + 2, 7), iso(at - 3, b + 2, 7)], true);
        }
      });
      break;
    }
    case "environment": {
      // A server: a tall box with vents, its status light bright.
      floor(24);
      stroke();
      box(-10, -14, 0, 20, 28, 34);
      for (let z = 6; z <= 28; z += 5.5) seg(iso(10, -10, z), iso(10, 6, z));
      stroke(BRIGHT, 0.4);
      ellipse(iso(10, 10, 29), 1.2, 0.8);
      break;
    }
    case "network": {
      // A grid of roads with junctions, and one route along it bright.
      floor(28);
      stroke(INK, 0.2);
      for (let v = -18; v <= 18; v += 12) {
        seg(iso(v, -24), iso(v, 24));
        seg(iso(-24, v), iso(24, v));
      }
      stroke(BRIGHT, 0.45);
      path([iso(-18, -24), iso(-18, -6), iso(6, -6), iso(6, 18), iso(24, 18)]);
      stroke();
      for (const [a, b] of [[-18, -6], [6, -6], [6, 18]] as P[]) ellipse(iso(a, b), 1.6, 1, "#ffffff");
      break;
    }
    case "traffic": {
      // A road with its lane line, and three vehicles on it, the leading one bright.
      stroke(INK, 0.2);
      path([iso(-30, -10), iso(30, -10)]);
      path([iso(-30, 10), iso(30, 10)]);
      pdf.setLineDashPattern([1.4, 1.4], 0);
      seg(iso(-30, 0), iso(30, 0));
      pdf.setLineDashPattern([], 0);
      stroke();
      box(-24, -7, 0, 11, 5, 4);
      box(-4, -7, 0, 11, 5, 4);
      box(-14, 2, 0, 11, 5, 4);
      stroke(BRIGHT, 0.35);
      path([iso(-4, -7, 4), iso(7, -7, 4), iso(7, -2, 4), iso(-4, -2, 4)], true);
      break;
    }
    case "signals": {
      // A signal head on a pole, its green lamp bright.
      floor(18);
      stroke();
      seg(iso(0, 0, 0), iso(0, 0, 18));
      box(-4, -3, 18, 8, 6, 22);
      [34, 27, 20].forEach((z, i) => {
        stroke(i === 2 ? BRIGHT : INK, i === 2 ? 0.4 : 0.22);
        ellipse(iso(4, 0, z + 2), 1.9, 1.9);
      });
      break;
    }
    case "weather": {
      // A cloud over the ground, with rain falling from it, one streak bright.
      floor(24);
      stroke();
      const cloud: P[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = (i / 24) * Math.PI * 2;
        const r = 14 + 3 * Math.cos(t * 3);
        cloud.push(flat(Math.cos(t) * r * 1.2, -24 + Math.sin(t) * r * 0.5));
      }
      path(cloud, true, "#ffffff");
      [-12, -6, 0, 6, 12].forEach((a, i) => {
        stroke(i === 2 ? BRIGHT : INK, i === 2 ? 0.4 : 0.2);
        seg(flat(a, -14), flat(a - 3, 2));
      });
      break;
    }
    case "flooding": {
      // A slab of ground with standing water drawn across it in waves, the top one bright.
      stroke();
      box(-24, -20, 0, 48, 40, 4);
      [-8, 0, 8].forEach((b, i) => {
        stroke(i === 0 ? BRIGHT : INK, i === 0 ? 0.4 : 0.2);
        const wave: P[] = [];
        for (let a = -18; a <= 18; a += 2) wave.push(iso(a, b + Math.sin(a / 3) * 1.6, 4.4));
        path(wave);
      });
      break;
    }
    case "incidents": {
      // Two cones on a kerb and a third lying down: nothing to close off. The standing one's band is bright.
      stroke();
      box(-28, 8, 0, 56, 6, 2);
      const cone = (a: number, b: number, bright: boolean) => {
        const base = iso(a, b, 2);
        const tip = iso(a, b, 22);
        stroke();
        ellipse(base, 6, 3, "#ffffff");
        path([[base[0] - 6 * k, base[1]], tip, [base[0] + 6 * k, base[1]]], false, "#ffffff");
        stroke(bright ? BRIGHT : INK, bright ? 0.4 : 0.22);
        seg([tip[0] - 2.8 * k, tip[1] + 10 * k], [tip[0] + 2.8 * k, tip[1] + 10 * k]);
      };
      cone(-12, 0, false);
      cone(10, -4, true);
      break;
    }
    case "timeline": {
      // A clock lying on a plinth, its hands at a time, the minute hand bright.
      stroke();
      box(-20, -20, 0, 40, 40, 3);
      ellipse(iso(0, 0, 3), 18 * C * 1.3, 18 * S * 1.3, "#ffffff");
      for (let h = 0; h < 12; h++) {
        const t = (h / 12) * Math.PI * 2;
        seg(iso(Math.cos(t) * 13, Math.sin(t) * 13, 3), iso(Math.cos(t) * 15, Math.sin(t) * 15, 3));
      }
      seg(iso(0, 0, 3), iso(-7, 3, 3));
      stroke(BRIGHT, 0.45);
      seg(iso(0, 0, 3), iso(4, -12, 3));
      break;
    }
    case "performance": {
      // A gauge: an arc of ticks with a needle in its upper part, bright.
      stroke();
      const centre = flat(0, 10);
      const arc: P[] = [];
      for (let i = 0; i <= 30; i++) {
        const t = Math.PI + (i / 30) * Math.PI;
        arc.push([centre[0] + Math.cos(t) * 30 * k, centre[1] + Math.sin(t) * 30 * k]);
      }
      path(arc);
      for (let i = 0; i <= 10; i++) {
        const t = Math.PI + (i / 10) * Math.PI;
        seg([centre[0] + Math.cos(t) * 26 * k, centre[1] + Math.sin(t) * 26 * k], [centre[0] + Math.cos(t) * 30 * k, centre[1] + Math.sin(t) * 30 * k]);
      }
      stroke(BRIGHT, 0.5);
      const t = Math.PI * 1.7;
      seg(centre, [centre[0] + Math.cos(t) * 23 * k, centre[1] + Math.sin(t) * 23 * k]);
      stroke();
      ellipse(centre, 2, 2, "#ffffff");
      break;
    }
    case "resources": {
      // A memory module: a board with chips on it and pins along its edge; one chip bright.
      stroke();
      box(-28, -9, 0, 56, 18, 2);
      [-22, -9, 4, 17].forEach((a, i) => {
        stroke();
        box(a, -5, 2, 9, 10, 2.5, i === 2 ? "#dff2f7" : FACE);
        if (i === 2) {
          stroke(BRIGHT, 0.4);
          path([iso(a, -5, 4.5), iso(a + 9, -5, 4.5), iso(a + 9, 5, 4.5), iso(a, 5, 4.5)], true);
        }
      });
      stroke(INK, 0.16);
      for (let a = -26; a <= 26; a += 2.6) seg(iso(a, 9, 0), iso(a, 11, 0));
      break;
    }
    case "integrity": {
      // A seed in a ring of hashes: the run tied to what reproduces it, the seed bright.
      floor(24);
      stroke(INK, 0.2);
      for (let i = 0; i < 18; i++) {
        const t = (i / 18) * Math.PI * 2;
        seg(iso(Math.cos(t) * 15, Math.sin(t) * 15), iso(Math.cos(t) * 19, Math.sin(t) * 19));
      }
      stroke(BRIGHT, 0.45);
      path(Array.from({ length: 25 }, (_, i): P => {
        const t = (i / 24) * Math.PI * 2;
        return iso(Math.cos(t) * 6, Math.sin(t) * 9, 6 + Math.sin(t) * 1.5);
      }), true, "#ffffff");
      break;
    }
    case "map": {
      // A folded map, three panels, a route across it bright.
      stroke();
      const panels: [number, number][] = [[-27, 0], [-9, 6], [9, 0], [27, 6]];
      for (let i = 0; i < 3; i++) {
        const [a0, z0] = panels[i], [a1, z1] = panels[i + 1];
        path([iso(a0, -16, z0), iso(a1, -16, z1), iso(a1, 16, z1), iso(a0, 16, z0)], true, i === 1 ? FACE : "#ffffff");
      }
      stroke(BRIGHT, 0.4);
      path([iso(-22, 10, 1.2), iso(-9, 2, 6), iso(4, -6, 1.5), iso(20, -10, 5)]);
      break;
    }
    case "methodology": {
      // An open book, its right page ruled, one line bright.
      stroke();
      path([iso(-24, -14, 2), iso(0, -14, 0), iso(0, 14, 0), iso(-24, 14, 2)], true, "#ffffff");
      path([iso(0, -14, 0), iso(24, -14, 2), iso(24, 14, 2), iso(0, 14, 0)], true, "#ffffff");
      [-8, -2, 4, 10].forEach((b, i) => {
        stroke(i === 1 ? BRIGHT : INK, i === 1 ? 0.4 : 0.18);
        seg(iso(4, b, 0.4), iso(20, b, 1.7));
        stroke(INK, 0.18);
        seg(iso(-20, b, 1.7), iso(-4, b, 0.4));
      });
      break;
    }
  }
  pdf.restoreGraphicsState?.();
  stroke(INK, 0.2);
}
