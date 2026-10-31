// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { ReactNode } from "react";
import { Icon } from "./Icons";

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

export function Section({ title, icon, children }: { title: string; icon?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{icon && <Icon name={icon} size={14} />}{title}</h3>
      {children}
    </section>
  );
}

/** A short statement of a state: unsupported, held, waiting. */
export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "ok" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`status-badge tone-${tone}`}>{children}</span>;
}

/**
 * A setting. A switch sits at the end of its row; anything larger goes on its own
 * line under the title and description, so nothing is cramped.
 */
export function Row({ title, hint, control, htmlFor, badge, icon, stacked = false }: { title: string; hint?: string; control: ReactNode; htmlFor?: string; badge?: ReactNode; icon?: string; stacked?: boolean }) {
  return (
    <div className={`settings-row${stacked ? " stacked" : ""}`}>
      {icon && <span className="settings-row-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>}
      <label className="settings-row-text" htmlFor={htmlFor}>
        <strong>{title}{badge}</strong>
        {hint && <span>{hint}</span>}
      </label>
      <div className="settings-row-control">{control}</div>
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
  options: { value: T; label: string; icon?: string }[];
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
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
