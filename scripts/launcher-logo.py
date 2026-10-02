#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Render the repository's SVG wordmark as portable Unicode half-block text.

Run from any directory after changing docs/assets/logo-wordmark.svg. This is a
build-time helper; the launcher reads the checked-in text without SVG packages
or terminal image protocols. Only the SVG's absolute M/C/Z paths are supported.
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/assets/logo-wordmark.svg"


def outlines():
    polygons = []
    for path in ET.parse(SOURCE).getroot().findall("{http://www.w3.org/2000/svg}path"):
        tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", path.attrib["d"])
        index = 0
        while index < len(tokens):
            command = tokens[index]
            index += 1
            if command == "M":
                current = tuple(map(float, tokens[index:index + 2]))
                index += 2
                polygon = [current]
            elif command == "C":
                values = list(map(float, tokens[index:index + 6]))
                index += 6
                p1, p2, p3 = values[:2], values[2:4], values[4:]
                for step in range(1, 17):
                    t = step / 16
                    u = 1 - t
                    polygon.append(tuple(u**3 * current[axis] + 3*u*u*t*p1[axis]
                                         + 3*u*t*t*p2[axis] + t**3*p3[axis] for axis in (0, 1)))
                current = p3
            elif command == "Z":
                polygons.append(polygon)
            else:
                raise ValueError(f"Unsupported SVG command: {command}")
    return polygons


def render(polygons, width, height):
    # Fit the actual filled paths with a small margin, rather than including
    # the SVG's surrounding whitespace. Terminal cells are about twice as tall
    # as they are wide; each half-block therefore represents a square sample.
    points = [point for polygon in polygons for point in polygon]
    x0, y0 = min(x for x, _ in points) - 4, min(y for _, y in points) - 3
    dx = max(x for x, _ in points) + 4 - x0
    dy = max(y for _, y in points) + 3 - y0

    def inside(x, y):
        filled = False
        for polygon in polygons:
            a = polygon[-1]
            for b in polygon:
                if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
                    filled = not filled
                a = b
        return filled

    def covered(column, pixel_row):
        count = sum(inside(x0 + (column + (sx + .5)/4) / width * dx,
                           y0 + (pixel_row + (sy + .5)/4) / (height*2) * dy)
                    for sx in range(4) for sy in range(4))
        return count >= 6

    lines = []
    for row in range(height):
        line = ""
        for column in range(width):
            upper = covered(column, row*2)
            lower = covered(column, row*2 + 1)
            line += " ▀▄█"[int(upper) + 2*int(lower)]
        lines.append(line.rstrip())
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    shapes = outlines()
    for filename, width, height in (("logo.txt", 76, 7), ("logo-small.txt", 54, 5)):
        target = ROOT / "dstns_launcher/assets" / filename
        target.write_text(render(shapes, width, height), encoding="utf-8")
        print(f"Wrote {target.relative_to(ROOT)} ({width} columns, {height} rows)")
