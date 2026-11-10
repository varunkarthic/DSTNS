// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { qrModules } from "../src/components/qr";

/** "DSTNS" as this encoder drew it when macOS's own QR reader (CoreImage) read it back, with 71 other codes. */
const DSTNS = [
    "#######.#..#..#######",
    "#.....#..#.##.#.....#",
    "#.###.#..##...#.###.#",
    "#.###.#.#.##..#.###.#",
    "#.###.#.##..#.#.###.#",
    "#.....#.#..#..#.....#",
    "#######.#.#.#.#######",
    "........#.###........",
    "#...#.######.#####..#",
    "#.#....###.##..#..#.#",
    "..#.#.#.#.##..###.##.",
    "....##...#...##.#....",
    "##....##....###..##.#",
    "........###.###..####",
    "#######.#...##...#.#.",
    "#.....#....##..#...#.",
    "#.###.#.##.#..###.#.#",
    "#.###.#...###....#.##",
    "#.###.#....#..#####..",
    "#.....#..#...##......",
    "#######.##..###..##.#",
];

describe("a QR code", () => {
  it("is drawn exactly as the one a phone's reader has read", () => {
    expect(qrModules("DSTNS")!.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""))).toEqual(DSTNS);
  });
  it("grows to the version that holds the text, and refuses what none up to 10 can", () => {
    expect(qrModules("https://example.org/")).toHaveLength(25);
    expect(qrModules("b".repeat(213))).toHaveLength(57);
    expect(qrModules("b".repeat(214))).toBeNull();
  });
});
