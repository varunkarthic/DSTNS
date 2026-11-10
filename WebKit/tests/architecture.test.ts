// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The observer's subsystems, and which may use which. Lower layers never reach up, so a model or a motion primitive
// can be read, tested and reused without the interface around it. A new import across a boundary fails here: either it
// belongs in a lower layer, or this table changes on purpose.
// @ts-expect-error -- @types/node is not a dependency; Vitest runs this file in Node.
import { readdirSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error -- as above.
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = "src";

/** Each subsystem, and the subsystems it may import from (besides itself). App.tsx and main.tsx may use all. */
const ALLOWED: Record<string, string[]> = {
  CoreMotion: [],
  core: ["CoreMotion"],
  simulation: ["core"],
  components: ["core", "CoreMotion", "assets"],
  notifications: ["core", "CoreMotion", "components"],
  map: ["core", "CoreMotion", "components", "notifications"],
  tutorial: ["core", "components"],
  webfabric: ["core", "CoreMotion", "components", "map"],
  film: ["core", "CoreMotion", "components", "map", "webfabric"],
  report: ["core", "components", "simulation", "map", "film", "assets"],
  panels: ["core", "CoreMotion", "components", "simulation", "notifications", "film", "webfabric"],
  styles: [],
};

/** Imports that cross a boundary for now, each with why. */
const EXCEPTIONS: Record<string, string> = {
  "components/Tooltip.tsx -> map/Legends.tsx": "an inspection tooltip draws a place's glyph",
  "webfabric/Slots.tsx -> panels/Dialogs.tsx": "an application's dialog shares the observer's scrim, until dialogs share one primitive",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

function resolve(from: string, spec: string): string | null {
  const base = path.normalize(path.join(path.dirname(from), spec));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const subsystem = (file: string) => {
  const parts = path.relative(SRC, file).split(path.sep);
  return parts.length > 1 ? parts[0] : "";
};

describe("the observer's architecture", () => {
  const all = files(SRC);

  it("has every file in a subsystem, but the entry points", () => {
    const loose = all.filter((f) => !subsystem(f)).map((f) => path.basename(f));
    expect(loose.sort()).toEqual(["App.tsx", "main.tsx", "vite-env.d.ts"]);
    const known = new Set([...Object.keys(ALLOWED), "assets"]);
    expect(all.map(subsystem).filter((s) => s && !known.has(s))).toEqual([]);
  });

  it("keeps each subsystem to the layers beneath it", () => {
    const crossings: string[] = [];
    for (const file of all) {
      const from = subsystem(file);
      if (!from) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:from|import\(|new URL\()\s*["'](\.{1,2}\/[^"'?]+)/g)) {
        const target = resolve(file, match[1]);
        if (!target) continue;
        const to = subsystem(target);
        if (!to || to === from || ALLOWED[from]?.includes(to)) continue;
        const crossing = `${path.relative(SRC, file)} -> ${path.relative(SRC, target)}`;
        if (!(crossing in EXCEPTIONS)) crossings.push(crossing);
      }
    }
    expect(crossings).toEqual([]);
  });

  it("has no exception left over once its import is gone", () => {
    for (const crossing of Object.keys(EXCEPTIONS)) {
      const [from, to] = crossing.split(" -> ");
      const text = readFileSync(path.join(SRC, from), "utf8");
      expect(text.includes(path.basename(to).replace(/\.tsx?$/, "")), crossing).toBe(true);
    }
  });
});
