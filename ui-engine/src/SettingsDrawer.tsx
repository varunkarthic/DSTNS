// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useScrollFade } from "./scrollFade";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icons";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "./notificationModel";
import { SKIP_OPTIONS, STEP_OPTIONS } from "./uiConfig";
import type { AutoFocusStrategy } from "./uiConfig";
import { formatDuration } from "./timeFormat";

/**
 * Settings, as a drawer that slides from the left edge over the map.
 *
 * Sections are self-contained so further settings can be added without
 * reorganising the drawer. Every setting here is a presentation choice: none
 * of it reaches the simulation.
 */

export interface SettingsValues {
  autoFocus: boolean;
  autoFocusAvailable: boolean;
  strategy: AutoFocusStrategy;
  dnd: boolean;
  mutedCategories: string[];
  mutedSeverities: string[];
  hour12: boolean;
  reduceMotion: boolean;
  motionLocked: boolean;
  skipSeconds: number;
  stepSeconds: number;
}

export interface SettingsActions {
  onReset: () => void;
  onAutoFocus: (on: boolean) => void;
  onStrategy: (s: AutoFocusStrategy) => void;
  onDnd: (on: boolean) => void;
  onMutedCategories: (ids: string[]) => void;
  onMutedSeverities: (ids: string[]) => void;
  onHour12: (on: boolean) => void;
  onReduceMotion: (on: boolean) => void;
  onSkipSeconds: (s: number) => void;
  onStepSeconds: (s: number) => void;
}

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ title, hint, control, htmlFor }: { title: string; hint?: string; control: ReactNode; htmlFor?: string }) {
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

function Segmented<T extends string | number>({
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

function toggle(list: string[], id: string, on: boolean, order: string[]) {
  const next = new Set(list);
  if (on) next.add(id);
  else next.delete(id);
  return order.filter((x) => next.has(x));
}

export function SettingsDrawer({
  open,
  onClose,
  values,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  values: SettingsValues;
  actions: SettingsActions;
}) {
  const scroll = useScrollFade<HTMLDivElement>();
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-settings-trigger]")) return;
      if (panel.current && !panel.current.contains(target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, onClose]);

  const categoryOrder = NOTIFICATION_CATEGORIES.map((c) => c.id as string);
  const severityOrder = NOTIFICATION_SEVERITIES.map((c) => c.id as string);

  return (
    <aside
      ref={panel}
      className={`settings-drawer${open ? " open" : ""}`}
      aria-label="Settings"
      aria-hidden={!open}
      inert={!open || undefined}
      role="dialog"
    >
      <header className="settings-head">
        <h2>Settings</h2>
        <button ref={closeRef} type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div {...scroll} className={`settings-scroll ${scroll.className}`} tabIndex={0} aria-label="Settings preferences">
        <button type="button" className="btn" onClick={actions.onReset}><Icon name="reset" size={16} />Reset settings</button>
        <Section title="Auto Focus">
          <Row
            title="Auto Focus Events"
            hint={
              values.autoFocusAvailable
                ? "Automatically follow significant simulation events. The camera frames each event's full footprint."
                : "Disabled for this deployment in ui-config.json."
            }
            htmlFor="set-autofocus"
            control={
              <Switch id="set-autofocus" label="Auto Focus Events" checked={values.autoFocus} disabled={!values.autoFocusAvailable} onChange={actions.onAutoFocus} />
            }
          />
          <Row
            title="Order"
            hint={values.strategy === "round-robin" ? "Visit every live event in turn." : "Stay on the most recent event."}
            control={
              <Segmented
                label="Auto Focus order"
                value={values.strategy}
                disabled={!values.autoFocusAvailable}
                onChange={actions.onStrategy}
                options={[
                  { value: "round-robin", label: "Round-Robin" },
                  { value: "latest", label: "Latest" },
                ]}
              />
            }
          />
        </Section>

        <Section title="Do Not Disturb">
          <Row
            title="Do Not Disturb"
            hint="Suppress selected notification categories. Events are still recorded and reported."
            htmlFor="set-dnd"
            control={<Switch id="set-dnd" label="Do Not Disturb" checked={values.dnd} onChange={actions.onDnd} />}
          />
          <fieldset className={`settings-checks${values.dnd ? "" : " dimmed"}`}>
            <legend>Muted categories</legend>
            {NOTIFICATION_CATEGORIES.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={values.mutedCategories.includes(c.id)}
                  onChange={(e) => actions.onMutedCategories(toggle(values.mutedCategories, c.id, e.target.checked, categoryOrder))}
                />
                <span className="check-box" aria-hidden="true">
                  <Icon name="check" size={14} strokeWidth={2.4} />
                </span>
                <span className="check-text">
                  {c.label}
                  <small>{c.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className={`settings-checks compact${values.dnd ? "" : " dimmed"}`}>
            <legend>Muted severities</legend>
            {NOTIFICATION_SEVERITIES.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={values.mutedSeverities.includes(c.id)}
                  onChange={(e) => actions.onMutedSeverities(toggle(values.mutedSeverities, c.id, e.target.checked, severityOrder))}
                />
                <span className="check-box" aria-hidden="true">
                  <Icon name="check" size={14} strokeWidth={2.4} />
                </span>
                <span className="check-text">{c.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="settings-note">
            When Auto Focus moves the camera to an event, that event's notification is shown even if its category is muted.
          </p>
        </Section>

        <Section title="Display">
          <Row
            title="Time format"
            hint="Applies to every simulation timestamp."
            control={
              <Segmented
                label="Time format"
                value={values.hour12 ? "12" : "24"}
                onChange={(v) => actions.onHour12(v === "12")}
                options={[
                  { value: "24", label: "24 h" },
                  { value: "12", label: "12 h" },
                ]}
              />
            }
          />
          <Row
            title="Reduce motion"
            hint={values.motionLocked ? "Held on by Adaptive Simulation Backpressure." : "Stills flow markers and non-essential animation."}
            htmlFor="set-motion"
            control={<Switch id="set-motion" label="Reduce motion" checked={values.reduceMotion} disabled={values.motionLocked} onChange={actions.onReduceMotion} />}
          />
        </Section>

        <Section title="Playback">
          <Row
            title="Back and Forward"
            hint="Virtual time skipped per press."
            control={
              <Segmented
                label="Skip interval"
                value={values.skipSeconds}
                onChange={actions.onSkipSeconds}
                options={SKIP_OPTIONS.map((s) => ({ value: s as number, label: formatDuration(s).replace(" 00 min", "").replace(" min", "m").replace(" h", "h") }))}
              />
            }
          />
          <Row
            title="Step"
            hint="Virtual time advanced per step. The run holds after each step."
            control={
              <Segmented
                label="Step interval"
                value={values.stepSeconds}
                onChange={actions.onStepSeconds}
                options={STEP_OPTIONS.map((s) => ({ value: s as number, label: formatDuration(s).replace(" s", "s").replace(" min", "m") }))}
              />
            }
          />
        </Section>
      </div>
    </aside>
  );
}
