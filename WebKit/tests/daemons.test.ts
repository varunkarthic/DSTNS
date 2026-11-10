// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { daemonNotification } from "../src/simulation/daemons";

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
