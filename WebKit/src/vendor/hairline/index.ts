// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic
// The figures of @lucasmarkes/hairline that DSTNS draws (MIT, see LICENSE), and one of its own on the same engine.
// Copied from https://github.com/lucasmarkes/hairline (packages/hairline/src) rather than installed, with only the
// figures used, so a bundle carries nothing else.

import { create, type Figure, type HairlineOptions } from "./mount";
import { mount as conesEngine } from "./figures/cones";
import { mount as drawerEngine } from "./figures/drawer";
import { mount as hubEngine } from "./figures/hub";
import { mount as loupeEngine } from "./figures/loupe";
import { mount as plotEngine } from "./figures/plot";
import { mount as plugEngine } from "./figures/plug";
import { mount as sieveEngine } from "./figures/sieve";
import { mount as terrainEngine } from "./figures/terrain";

export type { Figure, HairlineOptions } from "./mount";
export { setReducedMotion } from "./core/motion";

export const loupe = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "loupe", label: "A stand loupe over a blank ruled sheet: the pointer drags it across, and the rules pass enlarged under the glass with nothing between them.", rest: "rest", engine: loupeEngine }, el, options);

export const plug = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "plug", label: "A wall socket and a plug lying on the floor at the end of its cord: the pointer draws the plug up toward the socket, and it stops short of it.", rest: "rest", engine: plugEngine }, el, options);

export const drawer = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "drawer", label: "A filing cabinet of three drawers: the pointer's height picks one, it slides out, and inside are two dividers and nothing between them.", rest: "rest", engine: drawerEngine }, el, options);

export const hub = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "hub", label: "A hub and eight tiles on a grid: the tile under the pointer rises and its link turns solid; its neighbours rise less.", rest: "rest", engine: hubEngine, tour: [[205, 112], [260, 144], [328, 179], [263, 207], [201, 243], [131, 209], [76, 177], [136, 141], null] }, el, options);

export const cones = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "cones", label: "Traffic cones on a kerb with nothing to close off: the pointer's height picks a cone in the stack, and it lifts clear with those above it.", rest: "rest", engine: conesEngine, tour: [[150, 210], [150, 150], [150, 110], null] }, el, options);

export const plot = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "plot", label: "A bar chart with no data: seven flat tabs on its base, before a plate of grid lines. The pointer brushes them, and each lifts a little, the nearest most, and drops back to zero.", rest: "rest", engine: plotEngine }, el, options);

export const sieve = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "sieve", label: "Three test sieves stacked over a pan: the pointer's height picks one, it rises clear of the stack, and every mesh is bare.", rest: "rest", engine: sieveEngine }, el, options);

export const terrain = (el: HTMLElement, options?: HairlineOptions): Figure =>
  create({ id: "terrain", label: "Eighty-one pillars on a plinth that rise around the pointer and rest as a dune with two rises.", rest: "rest", engine: terrainEngine }, el, options);
