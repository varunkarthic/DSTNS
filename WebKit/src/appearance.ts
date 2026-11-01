// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Light and dark, and palettes for colour vision.
 *
 * Everything colour means (road state, severity, application series) comes from
 * one palette, published as CSS tokens and read by the map's canvas. Palettes were
 * chosen to stay apart under simulated colour vision; tests/appearance.test.ts
 * measures that with the Machado 2009 matrices, so it stays true.
 */

export type ThemeSetting = "system" | "dark" | "light";
export type ColorVision = "standard" | "protanopia" | "deuteranopia" | "tritanopia" | "monochrome";

export const COLOR_VISION_OPTIONS: { value: ColorVision; label: string; description: string; hint: string }[] = [
  { value: "standard", label: "Standard", description: "Full colour vision", hint: "The default palette, with red, amber and green road states." },
  { value: "protanopia", label: "Protanopia", description: "Red-blind: red looks dark and close to green", hint: "Road and severity colours are chosen so that nothing depends on seeing red." },
  { value: "deuteranopia", label: "Deuteranopia", description: "Green-blind: red and green look alike", hint: "Road and severity colours are chosen so that nothing depends on telling red from green. The most common form of colour blindness." },
  { value: "tritanopia", label: "Tritanopia", description: "Blue-blind: blue and green, yellow and pink look alike", hint: "Road and severity colours are chosen so that nothing depends on telling blue from green." },
  { value: "monochrome", label: "Monochrome", description: "No colour: everything is a shade of grey", hint: "States are told apart by brightness alone." },
];

export interface MeaningPalette {
  clear: string;
  moderate: string;
  severe: string;
  flooded: string;
  ok: string;
  warn: string;
  danger: string;
  accent: string;
  /** Categorical colours for applications, such as bus lines. */
  series: string[];
}

const OKABE_ITO_SERIES = ["#56b4e9", "#e69f00", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#bbbbbb"];
const OKABE_ITO_SERIES_LIGHT = ["#0072b2", "#b36b00", "#00795a", "#8a8200", "#0a4f8a", "#c04f00", "#a8528a", "#666666"];

const PALETTES: Record<"dark" | "light", Record<ColorVision, MeaningPalette>> = {
  dark: {
    standard: { clear: "#57d9b0", moderate: "#ffca66", severe: "#ff6577", flooded: "#4ba9ff", ok: "#5fe3c0", warn: "#ffb938", danger: "#ff6b73", accent: "#37d7ff", series: ["#7c9cf5", "#f2b35e", "#7fd18c", "#d98fb0", "#a58cf0", "#5fc9c4", "#e8d36b", "#9fb0bc"] },
    protanopia: { clear: "#56b4e9", moderate: "#f0e442", severe: "#c2410c", flooded: "#e4e4f4", ok: "#56b4e9", warn: "#f0e442", danger: "#e07000", accent: "#56b4e9", series: OKABE_ITO_SERIES },
    deuteranopia: { clear: "#56b4e9", moderate: "#f0e442", severe: "#c2410c", flooded: "#e4e4f4", ok: "#56b4e9", warn: "#f0e442", danger: "#e07000", accent: "#56b4e9", series: OKABE_ITO_SERIES },
    tritanopia: { clear: "#00b8a9", moderate: "#ffb3c6", severe: "#d0021b", flooded: "#f2f2f2", ok: "#00b8a9", warn: "#ffb3c6", danger: "#f03a4a", accent: "#00b8a9", series: ["#00b8a9", "#ff7f7f", "#f2f2f2", "#b00020", "#006d77", "#ffb3c6", "#7a7a7a", "#c9e4de"] },
    monochrome: { clear: "#7d7d7d", moderate: "#b4b4b4", severe: "#f4f4f4", flooded: "#555555", ok: "#c8c8c8", warn: "#e0e0e0", danger: "#ffffff", accent: "#e8e8e8", series: ["#ffffff", "#cccccc", "#aaaaaa", "#888888", "#e6e6e6", "#b8b8b8", "#979797", "#767676"] },
  },
  light: {
    standard: { clear: "#2fb391", moderate: "#e8a020", severe: "#dc3b4b", flooded: "#2f86e6", ok: "#096850", warn: "#805100", danger: "#ae2331", accent: "#085f9a", series: ["#3a5bd9", "#b86e12", "#2c8a3e", "#b5487a", "#6c4cd6", "#0e8a85", "#8c7a00", "#5b6b76"] },
    protanopia: { clear: "#0072b2", moderate: "#a89b00", severe: "#7a2e00", flooded: "#6b6b8a", ok: "#006096", warn: "#655d00", danger: "#9a4000", accent: "#006096", series: OKABE_ITO_SERIES_LIGHT },
    deuteranopia: { clear: "#0072b2", moderate: "#a89b00", severe: "#7a2e00", flooded: "#6b6b8a", ok: "#006096", warn: "#655d00", danger: "#9a4000", accent: "#006096", series: OKABE_ITO_SERIES_LIGHT },
    tritanopia: { clear: "#007d73", moderate: "#d6688a", severe: "#8f0015", flooded: "#555555", ok: "#00675e", warn: "#963c59", danger: "#b0001c", accent: "#00675e", series: ["#007d73", "#d6688a", "#333333", "#8f0015", "#00525a", "#b84a6e", "#808080", "#3f9d94"] },
    monochrome: { clear: "#9a9a9a", moderate: "#666666", severe: "#111111", flooded: "#c4c4c4", ok: "#4a4a4a", warn: "#333333", danger: "#000000", accent: "#222222", series: ["#000000", "#333333", "#555555", "#777777", "#222222", "#444444", "#666666", "#888888"] },
  },
};

/** What the map's canvas paints the land with. */
export interface MapPalette {
  land: string;
  park: string;
  buildingLine: string;
  roadBed: string;
  neutralRoad: string;
  label: string;
  labelHalo: string;
  marker: string;
  markerLine: string;
  markerInk: string;
  signal: string;
  flow: string;
}

const MAP_LAND: Record<"dark" | "light", MapPalette> = {
  dark: { land: "#122430", park: "#102c2d", buildingLine: "#29424e", roadBed: "#071420", neutralRoad: "#4a626c", label: "#c1d7df", labelHalo: "#071420", marker: "#162e3b", markerLine: "#638591", markerInk: "#d7e4f5", signal: "#06131e", flow: "#daf7f0" },
  light: { land: "#e7ebee", park: "#d5e8d4", buildingLine: "#d3dade", roadBed: "#ffffff", neutralRoad: "#b4bfc6", label: "#3c4d58", labelHalo: "#ffffff", marker: "#ffffff", markerLine: "#b7c2c9", markerInk: "#33454f", signal: "#ffffff", flow: "#0b5f4c" },
};

export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): "dark" | "light" {
  return setting === "system" ? (prefersDark ? "dark" : "light") : setting;
}

export function paletteFor(theme: "dark" | "light", vision: ColorVision): MeaningPalette {
  return PALETTES[theme][vision];
}

/** Read by the map on each paint. A change of revision asks it to repaint. */
export const appearance = {
  theme: "dark" as "dark" | "light",
  meaning: PALETTES.dark.standard,
  land: MAP_LAND.dark,
  revision: 0,
};

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const triplet = (hex: string) => {
  const m = HEX.exec(hex);
  return m ? `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}` : "0 0 0";
};

export function applyAppearance(options: { theme: "dark" | "light"; vision: ColorVision; reduceTransparency: boolean; advanced: boolean }, root: HTMLElement = document.documentElement) {
  const meaning = paletteFor(options.theme, options.vision);
  appearance.theme = options.theme;
  appearance.meaning = meaning;
  appearance.land = MAP_LAND[options.theme];
  appearance.revision += 1;
  root.dataset.theme = options.theme;
  root.dataset.vision = options.vision;
  root.classList.toggle("reduce-transparency", options.reduceTransparency);
  root.classList.toggle("basic-mode", !options.advanced);
  root.style.colorScheme = options.theme;
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  set("--state-clear", meaning.clear);
  set("--state-moderate", meaning.moderate);
  set("--state-severe", meaning.severe);
  set("--state-flooded", meaning.flooded);
  set("--ok", meaning.ok);
  set("--warn", meaning.warn);
  set("--amber", meaning.warn);
  set("--danger", meaning.danger);
  set("--red", meaning.danger);
  set("--accent", meaning.accent);
  set("--cyan", meaning.accent);
  set("--accent-rgb", triplet(meaning.accent));
  set("--danger-rgb", triplet(meaning.danger));
  set("--warn-rgb", triplet(meaning.warn));
  set("--ok-rgb", triplet(meaning.ok));
  meaning.series.forEach((colour, index) => set(`--series-${index}`, colour));
}
