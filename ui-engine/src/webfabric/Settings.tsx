// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icons";
import { Row, Section, Segmented, Switch } from "../settingsControls";
import webfabricLogo from "../assets/brand/webfabric-white.png";
import { fabric, useFabricApps } from "./store";
import type { AppState, FabricApp, SettingsField } from "./store";

/**
 * Settings → WebFabric. Every application's settings are drawn here from its own
 * schema, with the same controls as the rest of Settings. One application is on
 * screen at a time, so any number of them stays navigable.
 */

const STATE_LABEL: Record<AppState, string> = {
  registered: "Registered",
  initialized: "Initializing",
  active: "Active",
  suspended: "Suspended",
  failed: "Failed",
  unloaded: "Not running",
};

export const CAPABILITY_LABEL: Record<string, { label: string; hint: string; sensitive?: boolean }> = {
  "ui.header": { label: "Header items", hint: "Add buttons to the header." },
  "ui.status": { label: "Status", hint: "Show status lines over the map." },
  "ui.panels": { label: "Panels", hint: "Open its own side panels." },
  "ui.notifications": { label: "Notifications", hint: "Send notifications. Do Not Disturb still applies." },
  "ui.overlays": { label: "Map overlays", hint: "Draw on the map." },
  "ui.map-controls": { label: "Map controls", hint: "Add buttons to the map dock." },
  "ui.indicators": { label: "Edge indicators", hint: "Mark the edges of the map." },
  "ui.dialogs": { label: "Dialogs", hint: "Interrupt you with a dialog.", sensitive: true },
  "ui.frames": { label: "Its own pages", hint: "Show its own web page, in a sandbox, in a panel.", sensitive: true },
  settings: { label: "Its settings", hint: "Read and change its own settings." },
  "sim.read": { label: "Read the simulation", hint: "Follow the clock and congestion in its panels." },
  "control.playback": { label: "Control playback", hint: "Pause, seek, step and change speed.", sensitive: true },
  "control.events": { label: "Change the simulation", hint: "Inject events and overrides. This changes the results of the run.", sensitive: true },
  "control.world": { label: "Replace the world", hint: "Generate a new world, ending the current one.", sensitive: true },
};

function Field({ field, value, onChange }: { field: SettingsField; value: unknown; onChange: (value: unknown) => void }) {
  const id = `wf-${field.id}`;
  switch (field.type) {
    case "toggle":
      return <Row title={field.label} hint={field.hint} htmlFor={id} control={<Switch id={id} label={field.label} checked={value === true} onChange={onChange} />} />;
    case "select":
      if ((field.options?.length ?? 0) <= 3)
        return (
          <Row
            title={field.label}
            hint={field.hint}
            control={<Segmented label={field.label} value={value as string | number} options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))} onChange={onChange} />}
          />
        );
      return (
        <Row
          title={field.label}
          hint={field.hint}
          htmlFor={id}
          control={
            <select id={id} className="fabric-input" value={String(value)} onChange={(e) => onChange(field.options?.find((o) => String(o.value) === e.target.value)?.value)}>
              {(field.options ?? []).map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
            </select>
          }
        />
      );
    case "slider":
      return (
        <div className="settings-row fabric-slider-row">
          <label className="settings-row-text" htmlFor={id}>
            <strong>{field.label}</strong>
            {field.hint && <span>{field.hint}</span>}
          </label>
          <div className="fabric-slider">
            <input id={id} type="range" min={field.min} max={field.max} step={field.step ?? 1} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />
            <output htmlFor={id} className="mono">{String(value)}</output>
          </div>
        </div>
      );
    case "number":
      return <Row title={field.label} hint={field.hint} htmlFor={id} control={<input id={id} className="fabric-input" type="number" min={field.min} max={field.max} step={field.step} value={String(value)} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />} />;
    case "text":
      return <Row title={field.label} hint={field.hint} htmlFor={id} control={<input id={id} className="fabric-input" type="text" maxLength={field.max_length} value={String(value)} onChange={(e) => onChange(e.target.value)} />} />;
    default:
      return null;
  }
}

/** Sliders and text save when they stop moving; a refused value is shown, and not kept. */
function AppSettings({ app }: { app: FabricApp }) {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void fabric.settings(app.id).then((next) => live.current && setValues(next.values), (e: Error) => live.current && setError(e.message));
    const pending = timers.current;
    return () => {
      live.current = false;
      for (const timer of pending.values()) clearTimeout(timer);
    };
    // A re-registration with a new schema version is a different form.
  }, [app.id, app.settings?.version]);
  if (!app.settings?.groups.length) return <p className="settings-note">This application has no settings.</p>;
  if (error && !values) return <p className="fabric-error" role="alert">{error}</p>;
  if (!values) return <p className="settings-note">Loading…</p>;
  const save = (id: string, value: unknown, delay: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => {
      fabric.updateSettings(app.id, { [id]: value }).then(
        () => live.current && setError(""),
        (e: Error) => {
          if (!live.current) return;
          setError(e.message);
          void fabric.settings(app.id).then((next) => live.current && setValues(next.values));
        },
      );
    }, delay));
  };
  return (
    <>
      {app.settings.groups.map((group) => (
        <Section key={group.id} title={group.label}>
          {group.fields.map((field) => (
            <Field
              key={field.id}
              field={field}
              value={values[field.id] ?? field.default}
              onChange={(value) => {
                setValues((old) => ({ ...old, [field.id]: value }));
                save(field.id, value, field.type === "slider" || field.type === "text" || field.type === "number" ? 300 : 0);
              }}
            />
          ))}
        </Section>
      ))}
      {error && <p className="fabric-error" role="alert">{error}</p>}
      <button type="button" className="btn" onClick={() => void fabric.resetSettings(app.id).then((next) => { setValues(next.values); setError(""); })}>
        <Icon name="reset" size={16} />
        Reset to defaults
      </button>
    </>
  );
}

function AppPermissions({ app }: { app: FabricApp }) {
  const [error, setError] = useState("");
  const { requested, granted } = app.capabilities;
  if (!requested.length) return <p className="settings-note">This application asked for no permissions.</p>;
  return (
    <>
      {requested.map((capability) => {
        const info = CAPABILITY_LABEL[capability] ?? { label: capability, hint: "" };
        return (
          <Row
            key={capability}
            title={info.label}
            hint={info.hint}
            htmlFor={`wf-cap-${capability}`}
            control={
              <Switch
                id={`wf-cap-${capability}`}
                label={info.label}
                checked={granted.includes(capability)}
                onChange={(on) => {
                  setError("");
                  const next = on ? [...granted, capability] : granted.filter((item) => item !== capability);
                  fabric.grants(app.id, next).catch((e: Error) => setError(e.message));
                }}
              />
            }
          />
        );
      })}
      {error && <p className="fabric-error" role="alert">{error}</p>}
      <p className="settings-note">Applications that act on the simulation through Fabric are recorded under Details.</p>
    </>
  );
}

function AppDetails({ app, onForgotten }: { app: FabricApp; onForgotten: () => void }) {
  const [audit, setAudit] = useState<{ action: string; outcome: string; sequence: number }[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void fabric.audit().then((log) => live && setAudit(log.items.filter((item) => item.app_id === app.id).slice(-10).reverse()), () => undefined);
    return () => {
      live = false;
    };
  }, [app.id]);
  const act = (work: Promise<unknown>) => work.then(() => setError(""), (e: Error) => setError(e.message));
  return (
    <>
      <dl className="fabric-facts">
        <dt>State</dt>
        <dd>{STATE_LABEL[app.state]}{app.detail ? `. ${app.detail}` : ""}</dd>
        <dt>Version</dt>
        <dd className="mono">{app.version}</dd>
        <dt>Identifier</dt>
        <dd className="mono">{app.id}</dd>
        {app.author && (<><dt>Author</dt><dd>{app.author}</dd></>)}
      </dl>
      {app.description && <p className="settings-note">{app.description}</p>}
      {app.blocked_ui.length > 0 && <p className="settings-note">Waiting for permission to show: {app.blocked_ui.join(", ")}.</p>}
      {audit.length > 0 && (
        <Section title="Actions on the simulation">
          <ul className="fabric-audit">
            {audit.map((item) => (
              <li key={item.sequence}><span className="mono">{item.action}</span> <small>{item.outcome === "ok" ? "done" : item.outcome}</small></li>
            ))}
          </ul>
        </Section>
      )}
      {error && <p className="fabric-error" role="alert">{error}</p>}
      <div className="fabric-buttons">
        {app.state !== "unloaded" && (
          <button type="button" className="btn" onClick={() => void act(fabric.suspend(app.id, !app.user_suspended))}>
            {app.user_suspended ? "Resume" : "Suspend"}
          </button>
        )}
        <button type="button" className="btn danger" onClick={() => void act(fabric.forget(app.id).then(onForgotten))}>
          Forget application
        </button>
      </div>
    </>
  );
}

export function WebFabricSettings({ onBack }: { onBack: () => void }) {
  const apps = useFabricApps();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"settings" | "permissions" | "details">("settings");
  const [view, setView] = useState<"installed" | "permissions">("installed");
  const app = apps.find((item) => item.id === selected);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => apps.filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.id.includes(needle)), [apps, needle]);
  const waiting = apps.filter((item) => item.capabilities.pending.length > 0 && item.state !== "unloaded");

  if (app) {
    return (
      <div className="settings-page" key={app.id}>
        <button type="button" className="settings-back" onClick={() => setSelected(null)}>
          <Icon name="chevronRight" size={14} className="flip" />
          WebFabric
        </button>
        <h3 className="fabric-app-title">{app.name} <small className={`fabric-state state-${app.state}`}>{STATE_LABEL[app.state]}</small></h3>
        <Segmented
          label={`${app.name} section`}
          value={tab}
          onChange={setTab}
          options={[{ value: "settings", label: "Settings" }, { value: "permissions", label: "Permissions" }, { value: "details", label: "Details" }]}
        />
        <div className="settings-page-body" key={tab}>
          {tab === "settings" && <AppSettings app={app} />}
          {tab === "permissions" && <AppPermissions app={app} />}
          {tab === "details" && <AppDetails app={app} onForgotten={() => setSelected(null)} />}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <button type="button" className="settings-back" onClick={onBack}>
        <Icon name="chevronRight" size={14} className="flip" />
        Settings
      </button>
      <img className="fabric-logo" src={webfabricLogo} alt="WebFabric" height={22} />
      <p className="settings-note">Applications that have registered themselves with this DSTNS server. They are independent programs; DSTNS shows what they declare.</p>
      <Segmented
        label="WebFabric section"
        value={view}
        onChange={setView}
        options={[{ value: "installed", label: `Applications (${apps.length})` }, { value: "permissions", label: `Permissions (${waiting.length})` }]}
      />
      {view === "installed" ? (
        <>
          {apps.length > 5 && (
            <input type="search" className="fabric-input fabric-search" placeholder="Search applications" aria-label="Search applications" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {apps.length === 0 && <p className="settings-note">No applications have registered. An application registers itself by calling the Fabric API.</p>}
          {apps.length > 0 && shown.length === 0 && <p className="settings-note">No application matches “{query.trim()}”.</p>}
          <ul className="fabric-apps">
            {shown.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => { setSelected(item.id); setTab("settings"); }}>
                  <span>
                    <strong>{item.name}</strong>
                    <small className="mono">{item.version}</small>
                  </span>
                  <small className={`fabric-state state-${item.state}`}>{STATE_LABEL[item.state]}</small>
                  <Icon name="chevronRight" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {waiting.length === 0 && <p className="settings-note">No application is waiting for permission.</p>}
          <ul className="fabric-apps">
            {waiting.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => { setSelected(item.id); setTab("permissions"); }}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.capabilities.pending.map((c) => CAPABILITY_LABEL[c]?.label ?? c).join(", ")}</small>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
