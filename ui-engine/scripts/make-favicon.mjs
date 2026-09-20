// Derive the browser icon from the brand mark.
//
// The favicon is the D of the DSTNS wordmark, taken from the same
// `src/assets/logo.svg` the interface draws, so the two can never drift. The
// wordmark is one path holding every letter; its sub-paths are grouped into
// glyphs by their horizontal extent and the first group, the D, is kept with
// its geometry untouched. Replacing the logo and re-running this script
// re-cuts the icon.
//
//   node scripts/make-favicon.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const svg = readFileSync(path.join(root, "src/assets/logo.svg"), "utf8");

const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"[^>]*>/g)].map((m) => ({ tag: m[0], d: m[1] }));
if (!paths.length) throw new Error("logo.svg has no paths");

const declared = svg.match(/viewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
if (!declared || declared.length !== 4) throw new Error("logo.svg has no usable viewBox");
const page = { w: declared[2], h: declared[3] };

function boundsOf(d) {
  const numbers = d.match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    minX = Math.min(minX, numbers[i]);
    maxX = Math.max(maxX, numbers[i]);
    minY = Math.min(minY, numbers[i + 1]);
    maxY = Math.max(maxY, numbers[i + 1]);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// The backdrop covers the page; the wordmark is what is left.
const mark = paths.find((p) => {
  const b = boundsOf(p.d);
  return b && (b.maxX - b.minX) < page.w * 0.95;
});
if (!mark) throw new Error("logo.svg has no wordmark path");
const fill = mark.tag.match(/fill="([^"]+)"/)?.[1] ?? "#edf1f4";

// Each letter is one or more sub-paths. Group them by overlapping x ranges.
const parts = mark.d
  .split(/(?=M)/)
  .map((d) => ({ d, b: boundsOf(d) }))
  .filter((p) => p.b)
  .sort((a, b) => a.b.minX - b.b.minX);
const glyphs = [];
for (const part of parts) {
  const last = glyphs[glyphs.length - 1];
  if (last && part.b.minX <= last.maxX) {
    last.parts.push(part.d);
    last.maxX = Math.max(last.maxX, part.b.maxX);
    last.minY = Math.min(last.minY, part.b.minY);
    last.maxY = Math.max(last.maxY, part.b.maxY);
  } else {
    glyphs.push({ parts: [part.d], minX: part.b.minX, maxX: part.b.maxX, minY: part.b.minY, maxY: part.b.maxY });
  }
}
const d = glyphs[0];
if (!d) throw new Error("logo.svg wordmark has no glyphs");

// A square box around the D, with a little room so it is not tight to the edge.
const size = Math.max(d.maxX - d.minX, d.maxY - d.minY);
const pad = size * 0.18;
const box = size + pad * 2;
const x = d.minX - pad - (box - (d.maxX - d.minX)) / 2 + pad;
const y = d.minY - pad - (box - (d.maxY - d.minY)) / 2 + pad;
const round = (n) => Number(n.toFixed(2));

// No plate behind the mark: the icon is transparent, so it sits on whatever
// the browser, the tab strip or the bookmark bar puts behind it. The mark is
// light, which would disappear on a light tab strip, so the fill follows the
// browser's colour scheme. Browsers without SVG icons fall back to the
// declared fill.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(x)} ${round(y)} ${round(box)} ${round(box)}" width="64" height="64">
  <style>
    path { fill: ${fill}; }
    @media (prefers-color-scheme: light) { path { fill: #0b1c28; } }
  </style>
  <path d="${d.parts.join("")}" fill="${fill}"/>
</svg>
`;

mkdirSync(path.join(root, "public"), { recursive: true });
writeFileSync(path.join(root, "public/favicon.svg"), icon);
console.log(`favicon.svg written from ${glyphs.length} glyphs; D box ${round(box)} units`);
