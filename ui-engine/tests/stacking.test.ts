// @ts-expect-error -- @types/node is not a dependency; Vitest runs this file in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The workspace is an isolated stacking context, so a dialog inside it can only
// rise above the header if the workspace itself does. jsdom does not paint, so
// the rules that guarantee it are checked directly.
// Read from disk: Vitest's CSS pipeline empties "?raw" stylesheet imports, and
// jsdom replaces URL, so the path is relative to the package root Vitest runs in.
const css = (name: string): string => readFileSync(`src/${name}`, "utf8");
const variable = (source: string, name: string) => Number(source.match(new RegExp(`--${name}:\\s*(\\d+)`))?.[1]);

describe("dialog stacking", () => {
  it("lifts the workspace above the header while a dialog is open", () => {
    const theme = css("theme.css");
    const header = Number(theme.match(/\.app-header\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
    expect(header).toBeGreaterThan(0);
    expect(css("style.css")).toMatch(/\.workspace\s*\{[^}]*isolation:\s*isolate/);
    expect(css("system.css")).toMatch(/\.workspace:has\(>\s*\.scrim\)\s*\{\s*z-index:\s*var\(--z-scrim\)/);
    expect(variable(theme, "z-scrim")).toBeGreaterThan(header);
  });
});
