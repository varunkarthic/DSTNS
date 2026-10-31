// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { expect, it } from "vitest";
import { waveLine } from "../src/Icons";

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
