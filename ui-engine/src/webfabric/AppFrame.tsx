// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { fabric } from "./store";
import type { FabricApp, FabricElement } from "./store";

/** Requests a frame may send in a second before it is told to slow down. */
const MESSAGES_PER_SECOND = 120;
const READY_TIMEOUT_MS = 10000;

/**
 * An application's own page, in a sandbox.
 *
 * `allow-scripts` without `allow-same-origin` gives the frame an opaque origin:
 * it cannot reach this page's DOM, storage or cookies, and the server refuses it
 * as cross-origin. All it can do is post messages here, and each one is checked
 * against what this application has been granted. A page that only trusted
 * capability names would protect nothing; this boundary is the browser's.
 */
export function AppFrame({ app, element, onReply }: { app: FabricApp; element: FabricElement; onReply?: (message: unknown) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [silent, setSilent] = useState(false);
  const granted = useRef(app.capabilities.granted);
  granted.current = app.capabilities.granted;

  useEffect(() => {
    let ready = false;
    let window_ = performance.now();
    let count = 0;
    let unsubscribe: (() => void) | undefined;
    const post = (message: Record<string, unknown>) => {
      onReply?.(message);
      // An opaque origin cannot be named, so "*" it is; the frame is identified by
      // its window below, and is only ever sent what it has been granted.
      frame.current?.contentWindow?.postMessage({ fabric: 1, ...message }, "*");
    };
    const refuse = (id: unknown, code: string, message: string) => post({ id, type: "error", code, message });

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !frame.current?.contentWindow) return;
      const data = event.data as { fabric?: number; id?: unknown; type?: string; element?: string; action?: string; value?: unknown; changes?: Record<string, unknown> };
      if (!data || data.fabric !== 1 || typeof data.type !== "string") return;
      const now = performance.now();
      if (now - window_ > 1000) {
        window_ = now;
        count = 0;
      }
      // Refused out loud rather than dropped, so a frame knows to send it again.
      if (++count > MESSAGES_PER_SECOND) return refuse(data.id, "RATE_LIMITED", "Too many messages; send fewer.");
      switch (data.type) {
        case "ready":
          ready = true;
          setSilent(false);
          post({ type: "init", app: { id: app.id, name: app.name, version: app.version }, granted: granted.current });
          return;
        case "action":
          void fabric.action(app.id, typeof data.element === "string" ? data.element : element.id, typeof data.action === "string" ? data.action : "activate", data.value);
          return post({ id: data.id, type: "ok" });
        case "settings.get":
          if (!granted.current.includes("settings")) return refuse(data.id, "CAPABILITY_NOT_GRANTED", "settings");
          void fabric.settings(app.id).then(
            (settings) => post({ id: data.id, type: "settings", ...settings }),
            (error: Error) => refuse(data.id, "FAILED", error.message),
          );
          return;
        case "settings.set":
          if (!granted.current.includes("settings")) return refuse(data.id, "CAPABILITY_NOT_GRANTED", "settings");
          void fabric.updateSettings(app.id, data.changes ?? {}).then(
            (settings) => post({ id: data.id, type: "settings", ...settings }),
            (error: Error) => refuse(data.id, "INVALID_SETTINGS", error.message),
          );
          return;
        case "sim.subscribe":
          if (!granted.current.includes("sim.read")) return refuse(data.id, "CAPABILITY_NOT_GRANTED", "sim.read");
          unsubscribe ??= fabric.onSim((sim) => post({ type: "sim", ...sim }));
          return post({ id: data.id, type: "ok" });
        default:
          return refuse(data.id, "UNKNOWN_MESSAGE", data.type);
      }
    };
    window.addEventListener("message", onMessage);
    // A cross-origin frame's load errors cannot be observed; its silence can.
    const timer = setTimeout(() => {
      if (ready) return;
      setSilent(true);
      void fabric.failure(app.id, "Its frame did not respond.");
    }, READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      unsubscribe?.();
    };
    // Reconnects when the frame itself is replaced, not on each state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, element.id, element.frame, attempt]);

  return (
    <div className="fabric-frame">
      <iframe
        key={attempt}
        ref={frame}
        src={element.frame}
        title={`${app.name}: ${element.title ?? element.id}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
      {silent && (
        <div className="fabric-frame-error" role="alert">
          <p>This application's panel did not respond. DSTNS and other applications are unaffected.</p>
          <button type="button" className="btn" onClick={() => { setSilent(false); setAttempt((n) => n + 1); }}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
