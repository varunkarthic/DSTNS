// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { daemonNotification, coalesce } from "../src/simulation/daemons";

const message = (level: "info" | "warning" | "alert" | "emergency") => ({
  sequence: 7, id: "rcs.over_beta", level, queue: level === "alert" || level === "emergency" ? "daemonEmergencyQueue" : "daemonNotificationQueue",
  daemon: "rcs", title: "engine is using a lot of memory", text: "engine has used 2100 MiB…", data: { module: "engine", value: 2100.5, unit: "MiB", nested: { x: 1 } }, time_ms: 1,
});

describe("a daemon's message", () => {
  it("is a notification from System, at its level's severity", () => {
    expect(daemonNotification(message("info"), 60).severity).toBe("info");
    expect(daemonNotification(message("warning"), 60).severity).toBe("warning");
    expect(daemonNotification(message("alert"), 60).severity).toBe("alert");
    expect(daemonNotification(message("emergency"), 60).severity).toBe("alert");
    const note = daemonNotification(message("warning"), 60);
    expect(note).toMatchObject({ type: "DAEMON", category: "system", title: "engine is using a lot of memory", summary: "engine has used 2100 MiB…", timestamp: 60 });
    expect(note.id).toBe("daemon:daemonNotificationQueue:7");
    expect(note.app).toBeUndefined();
    // Its readings are shown; what is not a plain value is left to the technical details.
    expect(note.details).toEqual([{ label: "module", value: "engine" }, { label: "value", value: "2100.5" }, { label: "unit", value: "MiB" }]);
    expect(note.technical).toContainEqual({ label: "Daemon", value: "rcs" });
  });
});

describe("daemon warnings", () => {
  const note = (id: string) => ({ id, newsIds: [], type: "DAEMON", category: "system", severity: "warning", timestamp: 0, startedAt: 0, title: "Low on memory", summary: "", details: [], technical: [], count: 1 }) as never;
  it("are one notification however often a reading wavers, and separate for different warnings", () => {
    let showing = coalesce([], [{ note: note("daemon:n:1"), until: 10, key: "memory:memory.low" }]);
    for (let i = 2; i < 30; i++) showing = coalesce(showing, [{ note: note(`daemon:n:${i}`), until: 10 + i, key: "memory:memory.low" }]);
    expect(showing).toHaveLength(1);
    expect(showing[0].note.id).toBe("daemon:n:1");
    expect((showing[0].note as { count: number }).count).toBe(29);
    showing = coalesce(showing, [{ note: note("daemon:n:99"), until: 50, key: "disk:disk.low" }]);
    expect(showing).toHaveLength(2);
  });
});
