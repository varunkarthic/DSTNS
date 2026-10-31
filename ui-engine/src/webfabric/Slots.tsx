// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { Component, memo, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Icon } from "../Icons";
import { Tooltip } from "../Tooltip";
import { Scrim } from "../Dialogs";
import { Switch } from "../settingsControls";
import { useScrollFade } from "../scrollFade";
import { AppFrame } from "./AppFrame";
import { fabric, useFabricApps, useOpenPanel, useSlot } from "./store";
import type { FabricApp, FabricElement, FabricWidget, Tone } from "./store";

/**
 * Where applications' declared UI appears. Each slot belongs to the observer: it
 * decides placement, limits and appearance, and renders only the fields it knows,
 * as text. An application can say what to show, never how to draw it.
 */

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
    <div className={`fabric-status-item${toneClass(element.tone)}`} title={app.name}>
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

function Widget({ app, element, widget }: { app: FabricApp; element: FabricElement; widget: FabricWidget }) {
  const name = widget.id ?? element.id;
  const send = (action: string, value?: unknown) => void fabric.action(app.id, name, action, value).catch(() => undefined);
  const label = text(widget.label);
  switch (widget.type) {
    case "text":
      return <p className="fabric-text">{text(widget.text) || text(widget.value)}</p>;
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
        <button type="button" className={`btn fabric-action${toneClass(widget.tone)}`} onClick={() => send("activate")}>
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
          <select value={text(widget.value)} onChange={(e) => send("change", e.target.value)}>
            {(Array.isArray(widget.options) ? widget.options : []).map((option) => (
              <option key={String(option.value)} value={String(option.value)}>{text(option.label)}</option>
            ))}
          </select>
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
      <aside className="fabric-panel" role="dialog" aria-label={`${text(element.title) || element.id}, ${app.name}`}>
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
