// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { expect, it } from "vitest";
import { waveLine } from "../src/components/Icons";
import { paletteFor } from "../src/core/appearance";

const sheets = import.meta.glob<string>("../src/*.css", { query: "?raw", import: "default", eager: true });

it("takes every corner from the radius scale", () => {
  const stray: string[] = [];
  for (const [file, css] of Object.entries(sheets)) {
    for (const match of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const value = match[1].trim();
      // Hairline marks of up to 3px are too small to read as a corner.
      const allowed = value.split(/\s+/).every((part) => /^(var\(--r-(xs|sm|md|lg|pill)\)|inherit|0|50%|[1-3]px)$/.test(part));
      if (!allowed) stray.push(`${file}: ${value}`);
    }
  }
  expect(stray).toEqual([]);
});

it("draws the motion icon as one line that flattens, so its states can move between each other", () => {
  const shape = (d: string) => d.replace(/-?[\d.]+/g, "#");
  expect(shape(waveLine(9, 1))).toBe(shape(waveLine(9, 0.4)));
  expect(waveLine(9, 0)).toBe("M3 9c2.5 0 4.5 0 6.5 0s4 0 6 0 3.5 0 5.5 0");
});

it("lets a scroll pass through clipped text, which is a scroll container too", () => {
  for (const [file, css] of Object.entries(sheets)) {
    expect(css, file).not.toMatch(/(^|[\s,}])\*\s*\{[^}]*overscroll-behavior/);
  }
});

it("keeps whole-page ancestors out of :has(), where any change in the page restyles all of it", () => {
  for (const [file, css] of Object.entries(sheets)) {
    expect(css, file).not.toMatch(/(^|[\s,}])(html|body|#root|\.app-shell)[^{},]*:has\(/);
  }
});

it("declares filters once, because the minifier drops the standard one when both are written", () => {
  for (const [file, css] of Object.entries(sheets)) {
    expect(css, file).not.toMatch(/-webkit-(backdrop-filter|mask-image)\s*:/);
  }
});

it("keeps every light palette's meaning colours readable, even on their own tint", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const vision of ["standard", "protanopia", "deuteranopia", "tritanopia", "monochrome"] as const) {
    const palette = paletteFor("light", vision);
    for (const colour of [palette.ok, palette.warn, palette.danger, palette.accent]) {
      expect(1.05 / (luminance(colour) + 0.05), `${vision} ${colour}`).toBeGreaterThan(6);
    }
  }
});
