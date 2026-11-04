// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { appearance, applyAppearance, paletteFor, resolveTheme } from "../src/appearance";
import type { ColorVision } from "../src/appearance";
import { demandColor, stateColors } from "../src/mapModel";

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied in linear RGB.
const MATRICES: Record<string, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
/** CIE Lab, for a distance close to how different two colours look. */
function lab([r, g, b]: number[]) {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function seenAs(hex: string, vision: ColorVision) {
  const m = MATRICES[vision];
  const c = rgb(hex);
  const out = m ? m.map((row) => Math.max(0, Math.min(1, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) : c;
  return lab(out);
}
const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("palettes stay apart for the people they are for", () => {
  for (const theme of ["dark", "light"] as const)
    for (const vision of ["protanopia", "deuteranopia", "tritanopia"] as const)
      it(`${vision} on ${theme}: road states remain distinguishable`, () => {
        const p = paletteFor(theme, vision);
        const states = [p.clear, p.moderate, p.severe, p.flooded];
        for (let i = 0; i < states.length; i++)
          for (let j = i + 1; j < states.length; j++)
            expect(distance(seenAs(states[i], vision), seenAs(states[j], vision)), `${states[i]} and ${states[j]}`).toBeGreaterThan(18);
      });

  for (const theme of ["dark", "light"] as const)
    it(`monochrome on ${theme}: states differ by brightness alone`, () => {
      const p = paletteFor(theme, "monochrome");
      const lightness = [p.clear, p.moderate, p.severe, p.flooded].map((c) => lab(rgb(c))[0]).sort((a, b) => a - b);
      for (let i = 1; i < lightness.length; i++) expect(lightness[i] - lightness[i - 1]).toBeGreaterThan(10);
    });

  it("the standard palette is the established one", () => {
    expect(paletteFor("dark", "standard").accent).toBe("#37d7ff");
  });
});

describe("applying", () => {
  it("publishes tokens and modes, and the map reads the same palette", () => {
    const root = document.createElement("html");
    const before = appearance.revision;
    applyAppearance({ theme: "light", vision: "deuteranopia", reduceTransparency: true, advanced: false }, root);
    expect(root.dataset.theme).toBe("light");
    expect(root.classList.contains("reduce-transparency")).toBe(true);
    expect(root.classList.contains("basic-mode")).toBe(true);
    expect(root.style.getPropertyValue("--state-severe")).toBe(paletteFor("light", "deuteranopia").severe);
    expect(root.style.getPropertyValue("--series-0")).toBe(paletteFor("light", "deuteranopia").series[0]);
    expect(appearance.revision).toBe(before + 1);
    expect(stateColors.severe).toBe(paletteFor("light", "deuteranopia").severe);
    expect(demandColor(1.9)).toBe(`rgb(${[1, 3, 5].map((i) => parseInt(stateColors.severe.slice(i, i + 2), 16)).join(" ")})`);
    expect(root.classList.contains("high-contrast")).toBe(false);
    applyAppearance({ theme: "dark", vision: "standard", reduceTransparency: false, highContrast: true, advanced: true }, root);
    expect(root.classList.contains("basic-mode")).toBe(false);
    expect(root.classList.contains("high-contrast")).toBe(true);
  });

  it("follows the device only when asked to", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
