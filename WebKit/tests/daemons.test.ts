// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { describe, expect, it } from "vitest";
import { coalesce } from "../src/simulation/daemons";

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
