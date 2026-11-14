// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Figure } from "../CoreMotion/Figure";
import { Icon, type IconName } from "../components/Icons";
import { Row, Section, Segmented, Switch } from "../components/settingsControls";
import { BrandLogo } from "../components/BrandLogo";
import { Select } from "../components/Popover";
import { fabric, useFabricApps, useLaunchPlan, webOf } from "./store";
import type { AppState, FabricApp, FabricHealth, FabricSecurity, SettingsField } from "./store";
import { formatBytes } from "../core/units";

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
  reloading: "Reloading",
  unloaded: "Not running",
};

export const CAPABILITY_LABEL: Record<string, { label: string; hint: string; sensitive?: boolean }> = Object.assign(Object.create(null), {
  "ui.header": { label: "Header items", hint: "Add buttons to the header." },
  "ui.status": { label: "Status", hint: "Show status lines over the map." },
  "ui.panels": { label: "Panels", hint: "Open side panels." },
  "ui.sidebar": { label: "Sidebar", hint: "Show a sidebar beside the map." },
  "ui.deck": { label: "Telemetry section", hint: "Add a section to Live Telemetry." },
  "ui.notifications": { label: "Notifications", hint: "Send notifications. Do Not Disturb still applies." },
  "ui.overlays": { label: "Map overlays", hint: "Draw on the map." },
  "ui.map-controls": { label: "Map controls", hint: "Add buttons to the map dock." },
  "ui.indicators": { label: "Edge indicators", hint: "Mark the edges of the map." },
  "ui.dialogs": { label: "Dialogs", hint: "Interrupt you with a dialog.", sensitive: true },
  "ui.frames": { label: "Web pages", hint: "Show a web page in a sandboxed panel.", sensitive: true },
  "ui.camera": { label: "Move the map", hint: "Ask the map to move and zoom. Your own move always comes first.", sensitive: true },
  "ui.layers": { label: "Layers and places", hint: "Turn layers and places on or off for a while. Your own settings are not changed.", sensitive: true },
  settings: { label: "App settings", hint: "Read and change this application's settings." },
  "sim.read": { label: "Read the simulation", hint: "Read the clock and congestion." },
  "control.playback": { label: "Control playback", hint: "Pause, seek, step and change speed.", sensitive: true },
  "control.events": { label: "Change the simulation", hint: "Inject events and overrides. This changes the results of the run.", sensitive: true },
  "control.world": { label: "Replace the world", hint: "Generate a new world, ending the current one.", sensitive: true },
});

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
          stacked
          control={
            <Select label={field.label} className="wide" value={String(value)} onChange={(next) => onChange(field.options?.find((o) => String(o.value) === next)?.value)} options={(field.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))} />
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
      {[
        { title: "Needs your permission", items: requested.filter((c) => CAPABILITY_LABEL[c]?.sensitive) },
        { title: "Allowed by default", items: requested.filter((c) => !CAPABILITY_LABEL[c]?.sensitive) },
      ].filter((group) => group.items.length).map((group) => (
        <Section key={group.title} title={group.title}>
          {group.items.map((capability) => {
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
        </Section>
      ))}
      {error && <p className="fabric-error" role="alert">{error}</p>}
      <p className="fabric-disclaimer">
        <Icon name="info" size={16} />
        <span>Applications that act on the simulation through Fabric are recorded under Details, and you can take any permission back here at any time.</span>
      </p>
    </>
  );
}

function AppDetails({ app, onForgotten }: { app: FabricApp; onForgotten: () => void }) {
  const web = webOf(app, useLaunchPlan());
  const [audit, setAudit] = useState<{ action: string; outcome: string; sequence: number }[]>([]);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<FabricHealth | null>(null);
  useEffect(() => {
    let live = true;
    void fabric.audit().then((log) => live && setAudit(log.items.filter((item) => item.app_id === app.id).slice(-10).reverse()), () => undefined);
    // An older server has no health to report, and the page simply goes without it.
    const look = () => void fabric.health(app.id).then((next) => live && next?.events && setHealth(next), () => undefined);
    look();
    const timer = setInterval(look, 2000);
    return () => {
      live = false;
      clearInterval(timer);
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
        <dt>Requests</dt>
        <dd>{app.security?.signatures_required ? "Signed, and refused if not" : "Token only"}</dd>
        {!!app.security?.frame_origins.length && (<><dt>Frames from</dt><dd className="mono">{app.security.frame_origins.join(", ")}</dd></>)}
      </dl>
      {app.description && <p className="settings-note">{app.description}</p>}
      {app.blocked_ui.length > 0 && <p className="settings-note">Waiting for permission to show: {app.blocked_ui.join(", ")}.</p>}
      {health && <AppHealth health={health} />}
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
        {web && (
          <button type="button" className="btn" onClick={() => void window.open(web.url, "_blank", "noopener,noreferrer")}>
            <Icon name="external" size={14} />
            {web.label}
          </button>
        )}
        {app.state !== "unloaded" && (
          <>
            <button type="button" className="btn" onClick={() => void act(fabric.reload(app.id))}>
              <Icon name="reset" size={14} />
              Reload
            </button>
            <button type="button" className="btn" onClick={() => void act(fabric.suspend(app.id, !app.user_suspended))}>
              {app.user_suspended ? "Resume" : "Suspend"}
            </button>
          </>
        )}
        <button type="button" className="btn danger" onClick={() => void act(fabric.forget(app.id).then(onForgotten))}>
          Forget application
        </button>
      </div>
    </>
  );
}

/** The application's initial, in a tile tinted by its order, as DSTNS draws no one's logo. */
function AppTile({ app, large = false }: { app: FabricApp; large?: boolean }) {
  const initial = app.name.trim().charAt(0).toUpperCase() || "?";
  let hash = 0;
  for (const c of app.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return <span className={`fabric-tile${large ? " large" : ""}`} style={{ ["--tone" as string]: `var(--series-${hash % 8})` }} aria-hidden="true">{initial}</span>;
}

function StateChip({ state }: { state: AppState }) {
  return (
    <small className={`fabric-state state-${state}`}>
      <i aria-hidden="true" />
      {STATE_LABEL[state]}
    </small>
  );
}

function AppCard({ app, onOpen, picked, onPick }: { app: FabricApp; onOpen: () => void; picked: boolean; onPick: (on: boolean) => void }) {
  const waiting = app.capabilities.pending.length;
  return (
    <li className={picked ? "picked" : undefined}>
      <label className="fabric-pick">
        <input type="checkbox" checked={picked} aria-label={`Select ${app.name}`} onChange={(e) => onPick(e.target.checked)} />
        <span className="fabric-pick-box" aria-hidden="true" />
      </label>
      <button type="button" aria-label={app.name} onClick={onOpen}>
        <AppTile app={app} />
        <span className="fabric-app-text">
          <strong>{app.name}<small className="mono">{app.version}</small></strong>
          <small>{waiting > 0 && app.state !== "unloaded" ? `Waiting for ${waiting === 1 ? "1 permission" : `${waiting} permissions`}` : app.description || `Uses ${app.capabilities.granted.length} permissions`}</small>
        </span>
        <StateChip state={app.state} />
        <Icon name="chevronRight" size={14} />
      </button>
    </li>
  );
}

/** An application's health at a glance: one line saying whether anything needs attention and when it was last heard
 * from, the requests it made and how many were refused, then what it holds. Refusals, rate limits and lapsed leases
 * are tinted only when there are some. */
function AppHealth({ health }: { health: FabricHealth }) {
  const seen = health.last_seen_s;
  const fresh = seen === null ? "none" : seen < 10 ? "live" : seen < 60 ? "quiet" : "stale";
  const issues = [
    health.refused > 0 && `${health.refused.toLocaleString()} refused`,
    health.rate_limited > 0 && `${health.rate_limited.toLocaleString()} rate limited`,
    health.lease_lapses > 0 && `${health.lease_lapses} lease ${health.lease_lapses === 1 ? "lapse" : "lapses"}`,
  ].filter(Boolean) as string[];
  const accepted = Math.max(0, health.requests - health.refused - health.rate_limited);
  const share = health.requests > 0 ? accepted / health.requests : 1;
  // Large counts in a few characters (18.4k), the exact number on hover: the tiles are a third of the drawer wide.
  const compact = (n: number) => (n >= 10_000 ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n) : n.toLocaleString());
  const tile = (label: string, value: number, icon: IconName, warn = false) => (
    <div className={`fabric-health-tile${warn ? " warn" : ""}`} title={`${label}: ${value.toLocaleString()}`}>
      <small><Icon name={icon} size={12} />{label}</small>
      <strong className="mono">{compact(value)}</strong>
    </div>
  );
  return (
    <Section title="Health">
      <div className={`fabric-health-summary ${issues.length ? "warn" : "ok"}`}>
        <span className="fabric-health-state">
          <Icon name={issues.length ? "incident" : "check"} size={14} />
          {issues.length ? "Needs attention" : "Healthy"}
        </span>
        <span className="fabric-health-why">{issues.length ? issues.join(" · ") : "Every request answered"}</span>
        <span className={`fabric-health-seen ${fresh}`}>
          <i aria-hidden="true" />
          {seen === null ? "Not heard from yet" : `Seen ${seen < 1 ? "just now" : `${seen.toFixed(0)} s ago`}`}
        </span>
      </div>
      <div className="fabric-health-requests">
        {tile("Requests", health.requests, "pulse")}
        {tile("Refused", health.refused, "close", health.refused > 0)}
        {tile("Limited", health.rate_limited, "gauge", health.rate_limited > 0)}
        <div className="fabric-health-bar" role="img" aria-label={`${Math.round(share * 100)}% of requests answered`}>
          <i style={{ width: `${share * 100}%` }} />
        </div>
      </div>
      <dl className="fabric-health-grid">
        <div><dt><Icon name="queue" size={13} /> Events waiting</dt><dd className="mono">{health.events.queued.toLocaleString()}</dd></div>
        <div><dt><Icon name="stack" size={13} /> Interface</dt><dd className="mono">{health.ui.elements.toLocaleString()} {health.ui.elements === 1 ? "element" : "elements"}</dd></div>
        <div><dt><Icon name="download" size={13} /> Stored</dt><dd className="mono">{formatBytes(health.storage.bytes)}</dd></div>
        <div><dt><Icon name="clock" size={13} /> Timers</dt><dd className="mono">{health.timers}</dd></div>
        <div className={health.lease_lapses > 0 ? "warn" : undefined}><dt><Icon name="history" size={13} /> Lease lapses</dt><dd className="mono">{health.lease_lapses}</dd></div>
      </dl>
    </Section>
  );
}

/** What is protecting applications and what they do, read from the server rather than asserted. */
function SecurityPosture() {
  const [posture, setPosture] = useState<FabricSecurity | null>(null);
  useEffect(() => {
    let live = true;
    void fabric.security().then((next) => live && next?.audit && setPosture(next), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!posture) return null;
  const facts: { label: string; ok: boolean; state: string; detail: string }[] = [
    {
      label: "Connection",
      ok: posture.transport.tls,
      state: posture.transport.tls ? "Encrypted" : "Local only",
      detail: posture.transport.tls ? "TLS protects every request." : "Not encrypted: fine on this machine; use TLS or a gateway across a network.",
    },
    {
      label: "Credentials",
      ok: !posture.store.rejected,
      state: posture.store.rejected ? "Store rejected" : "Sealed",
      detail: posture.store.rejected ? "A changed store was rejected. Applications must register again." : "Tokens are kept only as hashes, in a sealed store.",
    },
    {
      label: "Audit log",
      ok: posture.audit.verification.intact,
      state: posture.audit.verification.intact ? "Intact" : "Altered",
      detail: posture.audit.verification.intact ? `${posture.audit.verification.checked.toLocaleString()} entries checked.` : "Entries have been altered; it does not verify.",
    },
    {
      label: "Signing",
      ok: true,
      state: `${posture.applications.requiring_signatures} of ${posture.applications.registered}`,
      detail: "Applications that must sign every request with their key.",
    },
  ];
  return (
    <Section title="Security">
      <ul className="fabric-security" aria-label="Security">
        {facts.map((fact) => (
          <li key={fact.label} className={fact.ok ? "ok" : "warn"}>
            <span className="fabric-security-mark" aria-hidden="true">{fact.ok ? "✓" : "!"}</span>
            <span className="fabric-security-text">
              <small>{fact.label}</small>
              <strong>{fact.state}</strong>
              <span>{fact.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function WebFabricSettingsPage({ onBack }: { onBack: () => void }) {
  const apps = useFabricApps();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"settings" | "permissions" | "details">("settings");
  const app = apps.find((item) => item.id === selected);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => apps.filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.id.includes(needle)), [apps, needle]);
  const isWaiting = (item: FabricApp) => item.capabilities.pending.length > 0 && item.state !== "unloaded";
  const waiting = shown.filter(isWaiting);
  const others = shown.filter((item) => !isWaiting(item));
  const active = apps.filter((item) => item.state === "active").length;
  // Several at once: those picked, or all of them.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState("");
  const pick = (id: string, on: boolean) => setPicked((old) => {
    const next = new Set(old);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const turn = async (on: boolean) => {
    // What a person picked is sent as picked: the list may not yet show a change made elsewhere, and the server takes a
    // repeat in its stride. "All" leaves out those already as asked, so as not to tell them twice.
    const ids = (picked.size ? apps.filter((item) => picked.has(item.id)) : apps.filter((item) => item.user_suspended === on)).filter((item) => item.state !== "unloaded").map((item) => item.id);
    if (!ids.length) return;
    setBulk(on ? "Turning on" : "Turning off");
    const failed = await fabric.suspendMany(ids, !on);
    setBulk(failed ? `${failed} of ${ids.length} could not be changed` : "");
    setPicked(new Set());
  };

  if (app) {
    return (
      <div className="settings-page" key={app.id}>
        <button type="button" className="settings-back" onClick={() => setSelected(null)}>
          <Icon name="chevronRight" size={14} className="flip" />
          WebFabric
        </button>
        <header className="fabric-app-head">
          <AppTile app={app} large />
          <div>
            <h3 className="fabric-app-title">{app.name}</h3>
            <small className="mono">{app.version}{app.author ? ` · ${app.author}` : ""}</small>
          </div>
          <StateChip state={app.state} />
        </header>
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

  const open = (item: FabricApp, next: typeof tab) => {
    setSelected(item.id);
    setTab(next);
  };
  return (
    <div className="settings-page">
      <button type="button" className="settings-back" onClick={onBack}>
        <Icon name="chevronRight" size={14} className="flip" />
        Settings
      </button>
      <header className="fabric-hero">
        <BrandLogo name="webfabric" height={22} />
        <p>Independent applications that have connected to this server through the Fabric API. Each one can add only what you allow.</p>
        <dl>
          <div><dt>Connected</dt><dd className="mono">{apps.length}</dd></div>
          <div><dt>Active</dt><dd className="mono">{active}</dd></div>
          <div className={apps.some(isWaiting) ? "tone-warn" : undefined}><dt>Waiting</dt><dd className="mono">{apps.filter(isWaiting).length}</dd></div>
        </dl>
      </header>
      {apps.length > 3 && (
        <label className="fabric-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search applications" aria-label="Search applications" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      {apps.length === 0 && (
        <div className="fabric-empty">
          <Figure name="socket" />
          <strong>No applications connected</strong>
          <p>An application registers itself by calling the Fabric API. It appears here as soon as it does.</p>
        </div>
      )}
      {apps.length > 0 && shown.length === 0 && <p className="settings-note">No application matches “{query.trim()}”.</p>}
      {apps.length > 0 && (
        <div className="fabric-bulk" role="group" aria-label="Turn several on or off">
          <span>{bulk || (picked.size ? `${picked.size} selected` : "All applications")}</span>
          <button type="button" className="btn" onClick={() => void turn(false)}>{picked.size ? "Turn off selected" : "Turn off all"}</button>
          <button type="button" className="btn" onClick={() => void turn(true)}>{picked.size ? "Turn on selected" : "Turn on all"}</button>
          {picked.size > 0 && <button type="button" className="btn ghost" onClick={() => setPicked(new Set())}>Clear</button>}
        </div>
      )}
      {waiting.length > 0 && (
        <section className="fabric-group">
          <h4>Waiting for permission</h4>
          <ul className="fabric-apps">
            {waiting.map((item) => <AppCard key={item.id} app={item} onOpen={() => open(item, "permissions")} picked={picked.has(item.id)} onPick={(on) => pick(item.id, on)} />)}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="fabric-group">
          {waiting.length > 0 && <h4>Applications</h4>}
          <ul className="fabric-apps">
            {others.map((item) => <AppCard key={item.id} app={item} onOpen={() => open(item, "settings")} picked={picked.has(item.id)} onPick={(on) => pick(item.id, on)} />)}
          </ul>
        </section>
      )}
      <SecurityPosture />
      </div>
  );
}

/**
 * WebFabric in Settings. Memoised: the drawer is drawn again every time the observer polls the run (each second),
 * and the applications' lists and permissions here, which change only when an application does, were drawn again
 * with it, mid-scroll, which made scrolling them stutter. They now follow the WebFabric store alone.
 */
export const WebFabricSettings = memo(WebFabricSettingsPage);
