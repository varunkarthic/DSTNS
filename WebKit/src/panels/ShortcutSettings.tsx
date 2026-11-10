// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useState } from "react";
import { Icon } from "../components/Icons";
import { Section } from "../components/settingsControls";
import { assignShortcut, keyName, resolveBindings, SHORTCUTS } from "../core/shortcuts";
import type { ShortcutId, ShortcutOverrides } from "../core/shortcuts";

/** Settings → Keyboard shortcuts. Choose one, press the new key, and it is set. */
export function ShortcutSettings({ overrides, onChange, onBack }: { overrides: ShortcutOverrides; onChange: (next: ShortcutOverrides) => void; onBack: () => void }) {
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [note, setNote] = useState("");
  const bindings = resolveBindings(overrides);
  useEffect(() => {
    if (!recording) return;
    // Ahead of everything else, so the key pressed is taken and does nothing besides.
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const name = keyName(event);
      if (!name) return;
      const holder = SHORTCUTS.find((shortcut) => shortcut.id !== recording && bindings[shortcut.id] === name);
      const target = SHORTCUTS.find((shortcut) => shortcut.id === recording);
      setNote(holder && target ? `${name} was ${holder.label}. ${holder.label} now uses ${bindings[recording]}.` : "");
      onChange(assignShortcut(overrides, recording, name));
      setRecording(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [recording, overrides, bindings, onChange]);
  const groups = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];
  const changed = Object.keys(overrides).length > 0;
  return (
    <div className="settings-page">
      <button type="button" className="settings-back" onClick={onBack}>
        <Icon name="chevronRight" size={14} className="flip" />
        Settings
      </button>
      <p className="settings-note">Select a shortcut, then press the key to use for it. A key already in use swaps with it.</p>
      {note && <p className="settings-note shortcut-note" role="status">{note}</p>}
      {groups.map((group) => (
        <Section key={group} title={group}>
          <ul className="shortcut-list">
            {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => {
              const active = recording === shortcut.id;
              return (
                <li key={shortcut.id}>
                  <span>{shortcut.label}</span>
                  <button
                    type="button"
                    className={`keycap${active ? " recording" : ""}${bindings[shortcut.id] !== shortcut.key ? " changed" : ""}`}
                    aria-label={`${shortcut.label}: ${bindings[shortcut.id]}. Change.`}
                    aria-pressed={active}
                    onClick={() => {
                      setNote("");
                      setRecording(active ? null : shortcut.id);
                    }}
                  >
                    {active ? "Press a key" : bindings[shortcut.id]}
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
      <button
        type="button"
        className="settings-action"
        disabled={!changed}
        onClick={() => {
          setNote("");
          onChange({});
        }}
      >
        <span className="settings-action-mark" aria-hidden="true"><Icon name="reset" size={16} /></span>
        <span className="settings-action-text">
          <strong>Reset shortcuts</strong>
          <small>{changed ? "Return every key to its default." : "Every key is at its default."}</small>
        </span>
      </button>
    </div>
  );
}
