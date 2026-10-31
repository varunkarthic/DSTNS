// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { Component, memo, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Icon } from "../Icons";
import { BrandLogo } from "../BrandLogo";
import { Tooltip } from "../Tooltip";
import { Scrim } from "../Dialogs";
import { Switch } from "../settingsControls";
import { Select } from "../Popover";
import { useScrollFade } from "../scrollFade";
import { settleTime, Spring, springEasing, SPRINGS } from "../motion";
import { AppFrame } from "./AppFrame";
import { fabric, useFabricApps, useOpenPanel, usePicking, useSlot } from "./store";
import type { FabricApp, FabricElement, FabricRow, FabricWidget, Tone } from "./store";

/**
 * Where applications' declared UI appears. Each slot belongs to the observer: it
 * decides placement, limits and appearance, and renders only the fields it knows,
 * as text. An application can say what to show, never how to draw it.
 */

/** An element's chosen motion, as attributes for webfabric.css. A custom spring becomes an easing. */
export function motionProps(element: FabricElement): { "data-motion"?: string; style?: Record<string, string> } {
  const motion = element.motion;
  if (!motion) return {};
  if (typeof motion === "string") return { "data-motion": motion };
  if (typeof motion.stiffness !== "number" || typeof motion.damping !== "number") return {};
  const preset = { k: motion.stiffness, c: motion.damping };
  return { "data-motion": "custom", style: { "--fabric-ease": springEasing(preset), "--fabric-ms": `${Math.round(settleTime(preset) * 1000)}ms` } };
}

const toneClass = (tone?: Tone) => (tone && ["accent", "ok", "warn", "danger"].includes(tone) ? ` tone-${tone}` : "");

/** One application's fault stops at that application: it is hidden and reported. */
export class AppBoundary extends Component<{ app: FabricApp; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    void fabric.failure(this.props.app.id, `Its interface could not be drawn: ${error.message}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function activate(app: FabricApp, element: FabricElement) {
  if (element.opens) fabric.setOpenPanel(`${app.id}/${element.opens}`);
  else void fabric.action(app.id, element.id).catch(() => undefined);
}

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

const HeaderItem = memo(function HeaderItem({ app, element }: { app: FabricApp; element: FabricElement }) {
  return (
    <Tooltip label={app.name} side={["bottom"]}>
      <button type="button" className={`btn fabric-action${toneClass(element.tone)}`} onClick={() => activate(app, element)}>
        {element.icon && <Icon name={element.icon} size={16} />}
        <span>{text(element.label) || element.id}</span>
      </button>
    </Tooltip>
  );
});

export function FabricHeader() {
  const { items } = useSlot("header");
  return (
    <>
      {items.map(({ app, element }) => (
        <AppBoundary key={`${app.id}/${element.id}`} app={app}>
          <HeaderItem app={app} element={element} />
        </AppBoundary>
      ))}
    </>
  );
}

const DockItem = memo(function DockItem({ app, element }: { app: FabricApp; element: FabricElement }) {
  const label = text(element.label) || element.id;
  return (
    <Tooltip label={label} detail={app.name} side={["right"]}>
      <button type="button" aria-label={`${label}, ${app.name}`} aria-pressed={element.active === true} className={`fabric-action${element.active ? " active" : ""}`} onClick={() => activate(app, element)}>
        <Icon name={element.icon ?? "info"} size={18} />
      </button>
    </Tooltip>
  );
});

export function FabricDockItems() {
  const { items } = useSlot("map_control");
  if (!items.length) return null;
  return (
    <>
      <div className="divider" aria-hidden="true" />
      {items.map(({ app, element }) => (
        <AppBoundary key={`${app.id}/${element.id}`} app={app}>
          <DockItem app={app} element={element} />
        </AppBoundary>
      ))}
    </>
  );
}

const StatusItem = memo(function StatusItem({ app, element }: { app: FabricApp; element: FabricElement }) {
  return (
    <div className={`fabric-status-item${toneClass(element.tone)}`} title={app.name} {...motionProps(element)}>
      <i aria-hidden="true" />
      <span>{text(element.label) || element.id}</span>
      {text(element.value) && <strong className="mono">{text(element.value)}</strong>}
    </div>
  );
});

export function FabricStatus() {
  const { items, overflow } = useSlot("status");
  if (!items.length) return null;
  return (
    <div className="fabric-status" role="status" aria-label="Application status">
      {items.map(({ app, element }) => (
        <AppBoundary key={`${app.id}/${element.id}`} app={app}>
          <StatusItem app={app} element={element} />
        </AppBoundary>
      ))}
      {overflow.length > 0 && <div className="fabric-status-item more">+{overflow.length} more</div>}
    </div>
  );
}

export function FabricIndicators() {
  const { items } = useSlot("indicator");
  return (
    <>
      {items.map(({ app, element }) => {
        const edge = ["top", "right", "bottom", "left"].includes(element.edge ?? "") ? element.edge! : "right";
        const place = typeof element.position === "number" ? Math.min(1, Math.max(0, element.position)) : 0.5;
        return (
          <div
            key={`${app.id}/${element.id}`}
            className={`fabric-indicator edge-${edge}${toneClass(element.tone)}`}
            style={{ ["--place" as string]: `${place * 100}%` }}
            role="img"
            aria-label={`${app.name}: ${text(element.label) || element.id}`}
            title={`${app.name}: ${text(element.label) || element.id}`}
          />
        );
      })}
    </>
  );
}

const seriesStyle = (series?: number) => (typeof series === "number" ? { ["--tone" as string]: `var(--series-${Math.abs(Math.trunc(series)) % 8})` } : undefined);

const FabricRowItem = memo(function FabricRowItem({ row, onSelect }: { row: FabricRow; onSelect?: () => void }) {
  const share = typeof row.share === "number" ? Math.min(1, Math.max(0, row.share)) : null;
  const inner = (
    <>
      {row.badge && <span className="fabric-row-badge mono">{text(row.badge).slice(0, 6)}</span>}
      <span className="fabric-row-text">
        <span>{text(row.subtitle) || text(row.title)}</span>
        {share !== null && <span className="fabric-row-bar"><i style={{ transform: `scaleX(${share})` }} /></span>}
      </span>
      {row.value !== undefined && <span className="fabric-row-value mono">{text(row.value)}</span>}
    </>
  );
  return (
    <li style={seriesStyle(row.series)} className={row.selected ? "selected" : undefined}>
      {onSelect ? <button type="button" aria-pressed={row.selected === true} onClick={onSelect}>{inner}</button> : <div>{inner}</div>}
    </li>
  );
});

function FabricTabs({ app, element, widget }: { app: FabricApp; element: FabricElement; widget: FabricWidget }) {
  const tabs = Array.isArray(widget.tabs) ? widget.tabs.slice(0, 6) : [];
  const [active, setActive] = useState(tabs[0]?.id);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!current) return null;
  const index = tabs.indexOf(current);
  return (
    <>
      <div className="fabric-tabs" role="tablist" style={{ ["--count" as string]: tabs.length, ["--pos" as string]: index }}>
        <span className="fabric-tabs-pill" aria-hidden="true" />
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab === current}
            onClick={() => {
              setActive(tab.id);
              void fabric.action(app.id, widget.id ?? element.id, "tab", tab.id).catch(() => undefined);
            }}
          >
            {tab.caption && <small className="mono">{text(tab.caption)}</small>}
            <strong>{text(tab.label)}</strong>
          </button>
        ))}
      </div>
      <div className="fabric-tab-body" key={current.id} role="tabpanel">
        {(Array.isArray(current.widgets) ? current.widgets : []).map((child, i) => (
          <Widget key={child.id ?? i} app={app} element={element} widget={child} />
        ))}
      </div>
    </>
  );
}

function FabricInput({ widget, onSubmit }: { widget: FabricWidget; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState(text(widget.value));
  const kind = widget.input_type === "time" || widget.input_type === "number" ? widget.input_type : "text";
  return (
    <form className="fabric-input-row" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
      {widget.label && <label>{text(widget.label)}</label>}
      <input className="fabric-input mono" type={kind} step={kind === "time" ? 1 : undefined} value={value} aria-label={text(widget.label) || "Value"} placeholder={widget.placeholder} onChange={(e) => setValue(e.target.value)} />
      {widget.submit && <button type="submit" className="btn fabric-action">{text(widget.submit)}</button>}
    </form>
  );
}

/** A figure with its recent history. Drawn to the panel's width, in the application's series or tone. */
function FabricSparkline({ widget }: { widget: FabricWidget }) {
  const values = (Array.isArray(widget.values) ? widget.values : []).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(-120);
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const line = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100} ${28 - ((v - low) / span) * 26}`).join(" L");
  return (
    <div className={`fabric-spark${toneClass(widget.tone)}`} style={seriesStyle(widget.series)}>
      <span>{text(widget.label)}</span>
      <strong className="mono">{text(widget.value)}</strong>
      {values.length > 1 && (
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`${text(widget.label) || "Figure"}: recent history`}>
          <path className="area" d={`M0 30 L${line} L100 30 Z`} />
          <path className="line" d={`M${line}`} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

function Widget({ app, element, widget }: { app: FabricApp; element: FabricElement; widget: FabricWidget }) {
  const name = widget.id ?? element.id;
  const send = (action: string, value?: unknown) => void fabric.action(app.id, name, action, value).catch(() => undefined);
  const label = text(widget.label);
  switch (widget.type) {
    case "text":
      return <p className="fabric-text">{text(widget.text) || text(widget.value)}</p>;
    case "heading":
      return <h3 className="fabric-heading">{text(widget.text) || label}</h3>;
    case "note":
      return <p className="fabric-note">{text(widget.text) || label}</p>;
    case "stats":
      return (
        <dl className="fabric-stats">
          {(Array.isArray(widget.items) ? widget.items : []).slice(0, 4).map((item, index) => (
            <div key={index} className={toneClass(item.tone).trim()}>
              <dt>{text(item.label)}</dt>
              <dd className="mono">{text(item.value)}{item.caption && <small>{text(item.caption)}</small>}</dd>
            </div>
          ))}
        </dl>
      );
    case "chips":
      return (
        <dl className="fabric-chips">
          {(Array.isArray(widget.items) ? widget.items : []).slice(0, 8).map((item, index) => (
            <div key={index}><dt>{text(item.label)}</dt><dd className="mono">{text(item.value)}</dd></div>
          ))}
        </dl>
      );
    case "list":
      return (
        <ul className="fabric-rows" aria-label={label || undefined}>
          {(Array.isArray(widget.rows) ? widget.rows : []).slice(0, 200).map((row, index) => (
            <FabricRowItem key={row.id ?? index} row={row} onSelect={row.id ? () => send("select", row.id) : undefined} />
          ))}
        </ul>
      );
    case "legend":
      return (
        <ul className="fabric-legend">
          {(Array.isArray(widget.legend) ? widget.legend : []).slice(0, 24).map((item, index) => (
            <li key={item.id ?? index} style={seriesStyle(item.series)} className={toneClass(item.tone).trim()}>
              {typeof item.value === "boolean" ? (
                <label>
                  <input type="checkbox" checked={item.value} onChange={(e) => void fabric.action(app.id, item.id ?? name, "change", e.target.checked).catch(() => undefined)} />
                  <span>{text(item.label)}</span>
                </label>
              ) : (
                <>
                  <i className={`mark-${item.mark ?? "line"}`} aria-hidden="true" />
                  <span>{text(item.label)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      );
    case "route":
      return (
        <ol className="fabric-route" aria-label={label || undefined} style={seriesStyle(widget.series)}>
          {(Array.isArray(widget.stops) ? widget.stops : []).slice(0, 64).map((stop, index) => (
            <li key={stop.id ?? index} className={stop.state ? `is-${stop.state}` : undefined} aria-current={stop.state === "current" ? "step" : undefined}>
              <i aria-hidden="true" />
              <span>{text(stop.label)}</span>
              {stop.caption && <small className="mono">{text(stop.caption)}</small>}
            </li>
          ))}
        </ol>
      );
    case "sparkline":
      return <FabricSparkline widget={widget} />;
    case "tabs":
      return <FabricTabs app={app} element={element} widget={widget} />;
    case "input":
      return <FabricInput widget={widget} onSubmit={(value) => send("submit", value)} />;
    case "stat":
      return (
        <div className={`fabric-stat${toneClass(widget.tone)}`}>
          <span>{label}</span>
          <strong className="mono">{text(widget.value)}</strong>
        </div>
      );
    case "progress": {
      const share = Math.min(1, Math.max(0, Number(widget.value) || 0));
      return (
        <div className={`fabric-progress${toneClass(widget.tone)}`}>
          <span>{label}</span>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={label || "Progress"}>
            <i style={{ transform: `scaleX(${share})` }} />
          </div>
        </div>
      );
    }
    case "button":
      return (
        <button type="button" className={`btn fabric-action${toneClass(widget.tone)}`} onClick={() => (widget.pick ? fabric.armPick(app.id, name) : send("activate"))}>
          {label || name}
        </button>
      );
    case "toggle":
      return (
        <div className="settings-row">
          <span className="settings-row-text"><strong>{label}</strong></span>
          <Switch label={label || name} checked={widget.value === true} onChange={(value) => send("change", value)} />
        </div>
      );
    case "select":
      return (
        <label className="fabric-field">
          <span>{label}</span>
          <Select label={label || name} value={text(widget.value)} onChange={(value) => send("change", value)} options={(Array.isArray(widget.options) ? widget.options : []).map((option) => ({ value: String(option.value), label: text(option.label) }))} />
        </label>
      );
    case "slider":
      return (
        <label className="fabric-field">
          <span>{label}</span>
          <input type="range" min={widget.min ?? 0} max={widget.max ?? 100} step={widget.step ?? 1} defaultValue={Number(widget.value) || 0} onPointerUp={(e) => send("change", Number(e.currentTarget.value))} onKeyUp={(e) => send("change", Number(e.currentTarget.value))} />
        </label>
      );
    default:
      return null;
  }
}

/** The one open application panel. Opening another replaces it. */
export function FabricPanel() {
  const open = useOpenPanel();
  const apps = useFabricApps();
  const scroll = useScrollFade<HTMLDivElement>();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [appId, elementId] = open?.split("/") ?? [];
  const app = apps.find((item) => item.id === appId);
  const element = app?.ui.find((item) => item.id === elementId && item.slot === "panel");
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fabric.setOpenPanel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!app || !element) return null;
  return (
    <AppBoundary key={open} app={app}>
      <aside className="fabric-panel" {...motionProps(element)} role="dialog" aria-label={`${text(element.title) || element.id}, ${app.name}`}>
        <header>
          <div>
            <h2>{text(element.title) || element.id}</h2>
            <small>{app.name}</small>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close panel" onClick={() => fabric.setOpenPanel(null)}>
            <Icon name="close" size={16} />
          </button>
        </header>
        {element.frame ? (
          <AppFrame app={app} element={element} />
        ) : (
          <div {...scroll} className={`fabric-panel-body ${scroll.className}`} tabIndex={0}>
            {(Array.isArray(element.widgets) ? element.widgets : []).map((widget, index) => (
              <Widget key={widget.id ?? index} app={app} element={element} widget={widget} />
            ))}
          </div>
        )}
      </aside>
    </AppBoundary>
  );
}

/** An application's content on the right, as a tab of the telemetry deck. */
export function FabricDeck() {
  const { items } = useSlot("deck");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const key = ({ app, element }: { app: FabricApp; element: FabricElement }) => `${app.id}/${element.id}`;
  const current = items.find((item) => key(item) === activeKey) ?? items[0];
  if (!current)
    return (
      <div className="fabric-empty">
        <BrandLogo name="webfabric" height={18} />
        <strong>Nothing to show yet</strong>
        <p>Applications connected through the Fabric API show their panels, figures and controls here.</p>
      </div>
    );
  const { app, element } = current;
  return (
    <div className="fabric-deck" {...motionProps(element)}>
      <header className="fabric-deck-head">
        <BrandLogo name="webfabric" height={14} />
        <small>{app.name}</small>
      </header>
      {items.length > 1 && (
        <div className="fabric-sidebar-apps" role="tablist" aria-label="Applications">
          {items.map((item) => (
            <button key={key(item)} type="button" role="tab" aria-selected={item === current} onClick={() => setActiveKey(key(item))}>
              {text(item.element.title) || item.app.name}
            </button>
          ))}
        </div>
      )}
      <AppBoundary key={key(current)} app={app}>
        {element.title && <h3 className="fabric-heading">{text(element.title)}</h3>}
        {element.frame ? <AppFrame app={app} element={element} /> : (Array.isArray(element.widgets) ? element.widgets : []).map((widget, index) => <Widget key={widget.id ?? index} app={app} element={element} widget={widget} />)}
      </AppBoundary>
    </div>
  );
}

const SIDEBAR_WIDTH = 372;

/**
 * Room on the map's left for an application to lay out its work, such as a planner
 * with its lines and journeys. The map refits beside it. Several applications share
 * it by tabs, and a person can put it away.
 */
export function FabricSidebar({ onInset, reduceMotion }: { onInset: (width: number) => void; reduceMotion: boolean }) {
  const { items } = useSlot("sidebar");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const picking = usePicking();
  const scroll = useScrollFade<HTMLDivElement>();
  const key = ({ app, element }: { app: FabricApp; element: FabricElement }) => `${app.id}/${element.id}`;
  const current = items.find((item) => key(item) === activeKey) ?? items[0];
  const present = !!current;
  const hidden = -(SIDEBAR_WIDTH + 96);
  const spring = useRef<Spring | null>(null);
  useEffect(() => {
    onInset(present && !collapsed ? 84 + SIDEBAR_WIDTH + 16 : 0);
    return () => onInset(0);
  }, [present, collapsed, onInset]);
  useEffect(() => {
    if (!panel.current) return;
    const element = panel.current;
    spring.current ??= new Spring(hidden, SPRINGS.expressiveDefault, (x) => element.style.setProperty("--sidebar-x", `${x.toFixed(2)}px`), 0.2);
    if (reduceMotion) spring.current.jump(collapsed ? hidden : 0);
    else spring.current.set(collapsed ? hidden : 0);
  }, [collapsed, reduceMotion, present, hidden]);
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fabric.cancelPick();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking]);
  if (!current) {
    spring.current = null;
    return null;
  }
  const { app, element } = current;
  return (
    <>
      <aside ref={panel} className="fabric-sidebar" aria-label={`${text(element.title) || app.name}, ${app.name}`} inert={collapsed || undefined}>
        <header>
          <div>
            <h2>{text(element.title) || app.name}</h2>
            {element.label && <small>{text(element.label)}</small>}
          </div>
          <button type="button" className="icon-btn" aria-label="Put the sidebar away" onClick={() => setCollapsed(true)}>
            <Icon name="panelCollapse" size={16} className="flip" />
          </button>
        </header>
        {items.length > 1 && (
          <div className="fabric-sidebar-apps" role="tablist" aria-label="Applications">
            {items.map((item) => (
              <button key={key(item)} type="button" role="tab" aria-selected={item === current} onClick={() => setActiveKey(key(item))}>
                {item.app.name}
              </button>
            ))}
          </div>
        )}
        <AppBoundary key={key(current)} app={app}>
          {element.frame ? (
            <AppFrame app={app} element={element} />
          ) : (
            <div {...scroll} className={`fabric-panel-body ${scroll.className}`} tabIndex={0}>
              {(Array.isArray(element.widgets) ? element.widgets : []).map((widget, index) => (
                <Widget key={widget.id ?? index} app={app} element={element} widget={widget} />
              ))}
            </div>
          )}
        </AppBoundary>
      </aside>
      {collapsed && (
        <button type="button" className="fabric-sidebar-tab" aria-label={`Open ${app.name}`} onClick={() => setCollapsed(false)}>
          <Icon name="panelExpand" size={16} className="flip" />
          <span>{app.name}</span>
        </button>
      )}
      {picking && (
        <div className="fabric-picking" role="status">
          <Icon name="pin" size={14} />
          Click a place on the map for {app.name}
          <button type="button" onClick={fabric.cancelPick}>Cancel</button>
        </div>
      )}
    </>
  );
}

/**
 * At most one application dialog, and only when the observer has nothing of its
 * own on screen. Answered once per content, so a repeated declaration does not
 * reopen what a person has already dismissed.
 */
export function FabricDialog({ blocked }: { blocked: boolean }) {
  const { items } = useSlot("dialog");
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const next = items.find(({ app, element }) => !answered.has(`${app.id}/${element.id}/${element.title}/${element.body}`));
  if (blocked || !next) return null;
  const { app, element } = next;
  const key = `${app.id}/${element.id}/${element.title}/${element.body}`;
  const answer = (action: string) => {
    setAnswered((old) => new Set(old).add(key));
    void fabric.action(app.id, element.id, action).catch(() => undefined);
  };
  return (
    <AppBoundary key={key} app={app}>
      <Scrim onClose={() => answer("dismiss")} labelledBy="fabric-dialog-title">
        <h2 id="fabric-dialog-title">{text(element.title) || app.name}</h2>
        <p className="fabric-dialog-from">From {app.name}</p>
        <p>{text(element.body)}</p>
        <div className="dialog-actions">
          {(Array.isArray(element.actions) && element.actions.length ? element.actions : [{ id: "ok", label: "OK" }]).slice(0, 3).map((action) => (
            <button key={action.id} type="button" className={`btn${toneClass("tone" in action ? action.tone : undefined)}`} onClick={() => answer(action.id)}>
              {text(action.label) || action.id}
            </button>
          ))}
        </div>
      </Scrim>
    </AppBoundary>
  );
}
