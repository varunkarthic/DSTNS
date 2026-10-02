// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { FIELD_OVERLAYS, rampColor, rasterPixels, sampleField } from "../src/fields";
import type { FieldRaster } from "../src/fields";

const luminance = ([r, g, b]: [number, number, number]) => {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

const raster: FieldRaster = {
  name: "elevation", units: "m", width: 3, height: 2, origin_x_m: 100, origin_y_m: 200, cell_m: 10,
  min: 0, max: 50, values: [0, 10, 20, 30, 40, 50],
};

describe("field overlays", () => {
  it("every ramp gets steadily lighter from low to high", () => {
    for (const f of FIELD_OVERLAYS) {
      let previous = -1;
      for (let i = 0; i <= 20; i++) {
        const l = luminance(rampColor(f.hue, i / 20));
        expect(l, `${f.label} at ${i / 20}`).toBeGreaterThan(previous);
        previous = l;
      }
      // The low end recedes into the dark map; the high end stands out from it.
      expect(luminance(rampColor(f.hue, 0))).toBeLessThan(0.06);
      expect(luminance(rampColor(f.hue, 1))).toBeGreaterThan(0.55);
    }
  });

  it("every field has a distinct hue, so two overlays are never confused", () => {
    expect(new Set(FIELD_OVERLAYS.map((f) => f.hue)).size).toBe(FIELD_OVERLAYS.length);
  });

  it("draws the south row at the bottom of the image", () => {
    const px = rasterPixels(raster, 70);
    const bottomLeft = [px[3 * 4], px[3 * 4 + 1], px[3 * 4 + 2]] as [number, number, number];
    const topRight = [px[2 * 4], px[2 * 4 + 1], px[2 * 4 + 2]] as [number, number, number];
    // values[0] (south-west, the minimum) sits in the image's bottom-left pixel.
    expect(luminance(bottomLeft)).toBeLessThan(luminance(topRight));
    expect(px[3]).toBeGreaterThan(0);
    const clear = rasterPixels(raster, 70, 0.6, (v) => v < 5);
    expect(clear[3 * 4 + 3]).toBe(0);
  });

  it("reads the value under a point, and nothing outside the field", () => {
    expect(sampleField(raster, 105, 205)).toBe(0);
    expect(sampleField(raster, 125, 215)).toBe(50);
    expect(sampleField(raster, 99, 205)).toBeNull();
    expect(sampleField(raster, 105, 221)).toBeNull();
  });
});
