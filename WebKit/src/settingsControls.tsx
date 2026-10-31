// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { ReactNode } from "react";

/** The controls every settings page is built from, including applications' own. */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <i aria-hidden="true" />
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Row({ title, hint, control, htmlFor }: { title: string; hint?: string; control: ReactNode; htmlFor?: string }) {
  return (
    <div className="settings-row">
      <label className="settings-row-text" htmlFor={htmlFor}>
        <strong>{title}</strong>
        {hint && <span>{hint}</span>}
      </label>
      {control}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="segmented" role="radiogroup" aria-label={label} style={{ ["--count" as string]: options.length, ["--pos" as string]: index }}>
      <span className="segmented-pill" aria-hidden="true" />
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
