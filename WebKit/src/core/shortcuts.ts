// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts. A person can change any of them in Settings; only what differs
 * from these defaults is stored, so resetting is simply forgetting.
 */

export interface Shortcut {
  id: ShortcutId;
  label: string;
  group: string;
  key: string;
}

export type ShortcutId =
  | "play" | "back" | "forward" | "step" | "slower" | "faster"
  | "zoom-in" | "zoom-out" | "fit" | "search" | "layers"
  | "auto-focus" | "dnd" | "motion" | "settings" | "telemetry" | "clock";

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "play", label: "Play or pause", group: "Playback", key: "Space" },
  { id: "back", label: "Back", group: "Playback", key: "J" },
  { id: "step", label: "Step", group: "Playback", key: "K" },
  { id: "forward", label: "Forward", group: "Playback", key: "L" },
  { id: "slower", label: "Slower", group: "Playback", key: "[" },
  { id: "faster", label: "Faster", group: "Playback", key: "]" },
  { id: "zoom-in", label: "Zoom in", group: "Map", key: "=" },
  { id: "zoom-out", label: "Zoom out", group: "Map", key: "-" },
  { id: "fit", label: "Fit the network", group: "Map", key: "F" },
  { id: "search", label: "Search places", group: "Map", key: "/" },
  { id: "layers", label: "Layers", group: "Map", key: "Y" },
  { id: "auto-focus", label: "Auto Focus", group: "Tools", key: "A" },
  { id: "dnd", label: "Do Not Disturb", group: "Tools", key: "D" },
  { id: "motion", label: "Reduce motion", group: "Tools", key: "M" },
  { id: "settings", label: "Settings", group: "Tools", key: "," },
  { id: "telemetry", label: "Collapse telemetry", group: "Tools", key: "T" },
  { id: "clock", label: "12 or 24 hour time", group: "Tools", key: "C" },
];

export type ShortcutOverrides = Partial<Record<ShortcutId, string>>;
export type Bindings = Record<ShortcutId, string>;

/** Keys that keep their usual meaning everywhere and cannot be taken. */
const RESERVED = new Set(["Escape", "Tab", "Enter", "Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified"]);

/** The name of a key press, or null if it cannot be a shortcut. */
export function keyName(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (RESERVED.has(event.key)) return null;
  const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const shift = event.shiftKey && event.key.length > 1;
  return `${event.ctrlKey ? "Ctrl+" : ""}${event.metaKey ? "Cmd+" : ""}${event.altKey ? "Alt+" : ""}${shift ? "Shift+" : ""}${key}`;
}

export function resolveBindings(overrides: ShortcutOverrides | undefined): Bindings {
  const out = {} as Bindings;
  for (const shortcut of SHORTCUTS) out[shortcut.id] = overrides?.[shortcut.id] ?? shortcut.key;
  return out;
}

/**
 * Give a shortcut a new key. A key already in use swaps, so nothing is ever left with
 * two meanings, or without one. Returns only what differs from the defaults.
 */
export function assignShortcut(overrides: ShortcutOverrides | undefined, id: ShortcutId, key: string): ShortcutOverrides {
  const bindings = resolveBindings(overrides);
  const holder = SHORTCUTS.find((shortcut) => shortcut.id !== id && bindings[shortcut.id] === key);
  if (holder) bindings[holder.id] = bindings[id];
  bindings[id] = key;
  const next: ShortcutOverrides = {};
  for (const shortcut of SHORTCUTS) if (bindings[shortcut.id] !== shortcut.key) next[shortcut.id] = bindings[shortcut.id];
  return next;
}

/**
 * Typing in a field is typing. Space presses a control only when the keyboard brought the focus there: a button that
 * was clicked keeps the focus, but Space after a click is meant for the simulation, not for that button again.
 */
export function shortcutsApply(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest("input:not([type='range']):not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true'], [role='listbox'], [role='menu'], iframe")) return false;
  if (key === "Space") {
    const control = target.closest("button, a, input, [role='switch'], [role='slider'], [role='tab'], [role='radio'], [role='option']");
    if (control && keyboardFocused(control)) return false;
  }
  return true;
}

/** Whether the focus came by keyboard. Without :focus-visible, assume it did, so nothing is pressed by surprise. */
function keyboardFocused(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function useShortcuts(bindings: Bindings, actions: Partial<Record<ShortcutId, () => void>>, enabled: boolean) {
  const current = useRef({ bindings, actions, enabled });
  current.current = { bindings, actions, enabled };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = current.current;
      if (!now.enabled || event.repeat || event.defaultPrevented) return;
      const name = keyName(event);
      if (!name || !shortcutsApply(event.target, name)) return;
      const shortcut = SHORTCUTS.find((item) => now.bindings[item.id] === name);
      const run = shortcut && now.actions[shortcut.id];
      if (!run) return;
      event.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
