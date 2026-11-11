// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { assignShortcut, keyName, resolveBindings, shortcutsApply, SHORTCUTS } from "../src/core/shortcuts";
import { mergeConfig, BUILT_IN, diffConfig } from "../src/core/uiConfig";

const press = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

describe("keyboard shortcuts", () => {
  it("has one action for every default key", () => {
    const keys = SHORTCUTS.map((shortcut) => shortcut.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names keys, and refuses those that keep their usual meaning", () => {
    expect(keyName(press(" "))).toBe("Space");
    expect(keyName(press("a"))).toBe("A");
    expect(keyName(press("a", { ctrlKey: true }))).toBe("Ctrl+A");
    expect(keyName(press("ArrowUp", { shiftKey: true }))).toBe("Shift+ArrowUp");
    for (const key of ["Escape", "Tab", "Enter", "Shift"]) expect(keyName(press(key))).toBeNull();
  });

  it("stores only what differs from the defaults", () => {
    expect(assignShortcut({}, "fit", "Z")).toEqual({ fit: "Z" });
    expect(assignShortcut({ fit: "Z" }, "fit", "F")).toEqual({});
  });

  it("swaps a key already in use, so no key has two meanings", () => {
    const next = resolveBindings(assignShortcut({}, "fit", "A"));
    expect(next.fit).toBe("A");
    expect(next["auto-focus"]).toBe("F");
  });

  it("leaves typing alone, and lets Space press a control only when the keyboard went there", async () => {
    const input = document.createElement("input");
    const clicked = document.createElement("button");
    const tabbed = document.createElement("button");
    document.body.append(input, clicked, tabbed);
    expect(shortcutsApply(input, "A")).toBe(false);
    expect(shortcutsApply(input, "Space")).toBe(false);
    clicked.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    clicked.focus();
    clicked.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(shortcutsApply(clicked, "Space")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    tabbed.focus();
    expect(shortcutsApply(tabbed, "Space")).toBe(false);
    expect(shortcutsApply(clicked, "A")).toBe(true);
    expect(shortcutsApply(document.body, "Space")).toBe(true);
    input.remove();
    clicked.remove();
    tabbed.remove();
  });

  it("survives saving and forgets what is unknown or malformed", () => {
    const merged = mergeConfig(BUILT_IN, { shortcuts: { fit: "Z", nonsense: "Q", play: 3 } });
    expect(merged.shortcuts).toEqual({ fit: "Z" });
    expect(diffConfig(BUILT_IN, merged).shortcuts).toEqual({ fit: "Z" });
    expect(diffConfig(BUILT_IN, BUILT_IN).shortcuts).toBeUndefined();
  });
});
