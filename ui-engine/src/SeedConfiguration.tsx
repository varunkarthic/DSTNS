// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Scrim } from "./Dialogs";
import { Icon } from "./Icons";
import { Segmented } from "./SettingsDrawer";
import type { SeedLocation, SeedMetadata } from "./types";

/**
 * The new-world dialog: how the next world's seed is chosen.
 *
 * Three ways, all ending in an ordinary seed. A random seed is what the
 * dialog has always done. An entered seed shows what it resolves to as it is
 * typed. A constrained seed is searched for by the core until its own
 * location, month and day type match the ones chosen; nothing about the world
 * is overridden, so the seed alone still reproduces it.
 */
export type SeedMode = "random" | "enter" | "constrain";

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SeedSummary({ meta }: { meta: SeedMetadata }) {
  return (
    <dl className="seed-summary" aria-label="Seed metadata">
      <dt>Seed</dt>
      <dd className="mono" data-testid="seed-value">{meta.seed}</dd>
      <dt>Location</dt>
      <dd>{meta.location.city}, {meta.location.country}</dd>
      <dt>Month</dt>
      <dd>{meta.month_name}</dd>
      <dt>Day type</dt>
      <dd>{meta.day_type === "weekend" ? "Weekend" : "Weekday"}</dd>
    </dl>
  );
}

export function WorldDialog({
  closing,
  onCancel,
  onConfirm,
}: {
  closing?: boolean;
  onCancel: () => void;
  /** Build the world: from `seed`, or from a fresh one when undefined. */
  onConfirm: (seed?: string) => void;
}) {
  const [mode, setMode] = useState<SeedMode>("random");
  const [text, setText] = useState("");
  const [described, setDescribed] = useState<SeedMetadata | null>(null);
  const [locations, setLocations] = useState<SeedLocation[]>([]);
  const [location, setLocation] = useState("auto");
  const [month, setMonth] = useState("auto");
  const [day, setDay] = useState<"auto" | "weekday" | "weekend">("auto");
  const [generated, setGenerated] = useState<SeedMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The catalogue is needed only to constrain; it is fetched once, on demand.
  useEffect(() => {
    if (mode !== "constrain" || locations.length) return;
    let live = true;
    api.seedLocations().then((r) => live && setLocations(r.data.items)).catch(() => live && setError("The location list could not be loaded."));
    return () => {
      live = false;
    };
  }, [mode, locations.length]);

  // An entered seed shows its metadata as soon as it is a valid number.
  const valid = /^[0-9]{1,39}$/.test(text) && !/^0+$/.test(text);
  useEffect(() => {
    setDescribed(null);
    if (mode !== "enter" || !valid) return;
    let live = true;
    const timer = setTimeout(() => {
      api.describeSeed(text)
        .then((r) => live && setDescribed(r.data))
        .catch((e) => live && setError(e instanceof Error ? e.message : "The seed could not be read."));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mode, text, valid]);

  // A constraint change invalidates the seed generated for the old ones.
  useEffect(() => setGenerated(null), [location, month, day]);
  useEffect(() => setError(""), [mode, text, location, month, day]);

  const sorted = useMemo(
    () => [...locations].sort((a, b) => a.city.localeCompare(b.city)),
    [locations],
  );

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.generateSeed({ location, month, day_type: day });
      setGenerated(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No seed could be generated.");
    } finally {
      setBusy(false);
    }
  };

  const seed = mode === "enter" ? (valid ? text : undefined) : mode === "constrain" ? generated?.seed : undefined;
  const ready = mode === "random" || !!seed;

  return (
    <Scrim onClose={onCancel} labelledBy="world-title" closing={closing} className="seed-dialog">
      <span className="dialog-icon" aria-hidden="true">
        <Icon name="reroll" size={20} />
      </span>
      <h2 id="world-title">Generate New World?</h2>
      <p className="dialog-body">
        A new seed picks a new district, which may need a map download. The current simulation stays where it is until
        the new world is ready, then hands over. The new world begins paused at the start of the day.
      </p>
      <div className="seed-config">
        <span className="seed-label" id="seed-init">Initialization</span>
        <Segmented<SeedMode>
          label="Initialization"
          value={mode}
          onChange={setMode}
          options={[
            { value: "random", label: "Random seed" },
            { value: "enter", label: "Enter seed" },
            { value: "constrain", label: "Constrained seed" },
          ]}
        />
        {mode === "enter" && (
          <label className="seed-field">
            <span className="seed-label">Seed</span>
            <input
              className="seed-input mono"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              aria-label="Seed"
              placeholder="e.g. 382923"
              value={text}
              onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, "").slice(0, 39))}
            />
          </label>
        )}
        {mode === "constrain" && (
          <div className="seed-constraints">
            <label className="seed-field">
              <span className="seed-label">Location</span>
              <select aria-label="Location" value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="auto">Auto</option>
                {sorted.map((l) => (
                  <option key={l.index} value={l.city}>
                    {l.city}, {l.country}
                  </option>
                ))}
              </select>
            </label>
            <label className="seed-field">
              <span className="seed-label">Month</span>
              <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
                <option value="auto">Auto</option>
                {MONTHS.map((m, i) => (
                  <option key={m} value={String(i + 1)}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="seed-field">
              <span className="seed-label">Day type</span>
              <select aria-label="Day type" value={day} onChange={(e) => setDay(e.target.value as typeof day)}>
                <option value="auto">Auto</option>
                <option value="weekday">Weekday</option>
                <option value="weekend">Weekend</option>
              </select>
            </label>
            <button type="button" className="btn" onClick={() => void generate()} disabled={busy}>
              {busy ? "Searching…" : "Generate Seed"}
            </button>
          </div>
        )}
        {mode === "enter" && described && <SeedSummary meta={described} />}
        {mode === "constrain" && generated && <SeedSummary meta={generated} />}
        {mode === "random" && <p className="seed-note">A fresh seed is drawn; its location, month and day type are its own.</p>}
        {error && (
          <p className="seed-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => onConfirm(seed)} disabled={!ready}>
          Generate
        </button>
      </div>
    </Scrim>
  );
}
