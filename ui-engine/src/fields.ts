// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Continuous environmental fields drawn over the map.
 *
 * At most one field overlay is shown at a time: two heatmaps stacked on one
 * map cannot both be read. Each field has its own single-hue sequential ramp,
 * dark at the low end so it recedes into the dark map and bright at the high
 * end, with lightness rising monotonically (it is built in OKLCH, where
 * lightness is perceptual). Colour carries magnitude only; the legend gives the
 * numbers and the pointer readout gives the value under the cursor.
 */

export type FieldOverlay = "none" | "elevation" | "wind" | "solar" | "temperature" | "flood";

export interface FieldRaster {
  name: string;
  units: string;
  width: number;
  height: number;
  origin_x_m: number;
  origin_y_m: number;
  cell_m: number;
  solver_cell_m?: number;
  min: number;
  max: number;
  /** Row-major, south row first. */
  values: number[];
  /** For vector fields (wind): the second component, same layout. */
  values_v?: number[];
}

export interface FieldInfo {
  id: Exclude<FieldOverlay, "none">;
  /** The core's field name. */
  field: string;
  label: string;
  units: string;
  /** OKLCH hue of the ramp, degrees. */
  hue: number;
  /** Whether the field changes as the simulation runs. */
  dynamic: boolean;
  /** Digits shown in the readout and legend. */
  digits: number;
  description: string;
}

export const FIELD_OVERLAYS: FieldInfo[] = [
  { id: "elevation", field: "elevation", label: "Elevation", units: "m", hue: 70, dynamic: false, digits: 1, description: "Terrain height above sea level" },
  { id: "wind", field: "wind", label: "Wind", units: "m/s", hue: 195, dynamic: true, digits: 1, description: "Near-surface wind speed and direction" },
  { id: "solar", field: "irradiance", label: "Solar irradiance", units: "W/m²", hue: 95, dynamic: true, digits: 0, description: "Sunlight reaching the surface" },
  { id: "temperature", field: "surface_temperature", label: "Surface temperature", units: "°C", hue: 40, dynamic: true, digits: 1, description: "Temperature of the ground and road surface" },
  { id: "flood", field: "water_depth", label: "Flood depth", units: "m", hue: 245, dynamic: true, digits: 2, description: "Standing and flowing surface water" },
];

export const fieldInfo = (id: FieldOverlay) => FIELD_OVERLAYS.find((f) => f.id === id);

// ---- Colour -----------------------------------------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** OKLCH (L 0..1, C, h degrees) to sRGB bytes, clipped to gamut. */
export function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr),
    b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3,
    M = m_ ** 3,
    S = s_ ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return lin.map((v) => {
    const x = clamp01(v);
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(clamp01(g) * 255);
  }) as [number, number, number];
}

/** The ramp colour for a fraction t in [0, 1] of the field's range. */
export function rampColor(hue: number, t: number): [number, number, number] {
  const u = clamp01(t);
  // Lightness 0.30 -> 0.92 rises monotonically; chroma swells mid-ramp so the
  // ends stay inside the sRGB gamut and the middle stays saturated.
  return oklchToRgb(0.3 + 0.62 * u, 0.05 + 0.08 * Math.sin(Math.PI * u), hue);
}

export const rampCss = (hue: number, t: number) => {
  const [r, g, b] = rampColor(hue, t);
  return `rgb(${r} ${g} ${b})`;
};

/** A CSS gradient of the ramp, for legends. */
export function rampGradient(hue: number, steps = 8): string {
  const stops = Array.from({ length: steps + 1 }, (_, i) => `${rampCss(hue, i / steps)} ${((i / steps) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/**
 * RGBA pixels of a raster, top row first (the raster's north row), ready for
 * ImageData. Values are mapped onto [min, max]; a flat field draws mid-ramp.
 * Cells for which `transparent` is true are left clear.
 */
export function rasterPixels(
  raster: FieldRaster,
  hue: number,
  alpha = 0.62,
  transparent?: (value: number) => boolean,
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, values, min, max } = raster;
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const span = max - min;
  const a = Math.round(alpha * 255);
  for (let row = 0; row < height; row++) {
    const j = height - 1 - row;
    for (let i = 0; i < width; i++) {
      const v = values[j * width + i];
      const o = (row * width + i) * 4;
      if (!Number.isFinite(v) || transparent?.(v)) continue;
      const [r, g, b] = rampColor(hue, span > 0 ? (v - min) / span : 0.5);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

/** The field's value at a point in local metres, or null outside the raster. */
export function sampleField(raster: FieldRaster, x_m: number, y_m: number, values = raster.values): number | null {
  const i = Math.floor((x_m - raster.origin_x_m) / raster.cell_m);
  const j = Math.floor((y_m - raster.origin_y_m) / raster.cell_m);
  if (i < 0 || j < 0 || i >= raster.width || j >= raster.height) return null;
  const v = values[j * raster.width + i];
  return Number.isFinite(v) ? v : null;
}

export function formatFieldValue(info: FieldInfo, value: number): string {
  return `${value.toFixed(info.digits)} ${info.units}`;
}
