// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { useSimulation } from "../src/useSimulation";
import type { Envelope, Snapshot, Status, Topology } from "../src/types";
const envelope = <T,>(run: string, data: T): Envelope<T> => ({ run_id: run, data, clock: { virtual_day_seconds: 0 } } as Envelope<T>);
const status = (run: string, lifecycle: string, preparation_error = "") => envelope(run, { lifecycle, preparation_error } as Status);
const snapshot = (run: string) => envelope(run, { edges: [], signals: [], congestion: { current: 0 } } as unknown as Snapshot);
const topology = (run: string) => envelope(run, { nodes: [{id: 1}], edges: [{id: 1}], features: [] } as unknown as Topology);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("loads when the UI opens before map data, without querying unavailable topology", async () => {
  const st = vi.spyOn(api,"status").mockResolvedValue(status("", "PREPARING"));
  const sn = vi.spyOn(api,"snapshot").mockResolvedValue(snapshot("new"));
  const tp = vi.spyOn(api,"topology").mockResolvedValue(topology("new"));
  vi.spyOn(api,"news").mockResolvedValue(envelope("new", {items:[]}));
  const { result }=renderHook(()=>useSimulation());
  await waitFor(()=>expect(result.current.stage).toBe("Preparing the world"));
  expect(sn).not.toHaveBeenCalled(); expect(tp).not.toHaveBeenCalled();
  st.mockResolvedValue(status("new","PAUSED"));
  await waitFor(()=>expect(result.current.topology?.nodes).toHaveLength(1), {timeout:2500});
  expect(result.current.snapshot?.run_id).toBe("new"); expect(result.current.error).toBe("");
});
it("clears the previous topology immediately and waits for replacement data", async () => {
  const st=vi.spyOn(api,"status").mockResolvedValue(status("old","PAUSED"));
  const sn=vi.spyOn(api,"snapshot").mockResolvedValue(snapshot("old"));
  const tp=vi.spyOn(api,"topology").mockResolvedValue(topology("old"));
  vi.spyOn(api,"news").mockResolvedValue(envelope("old",{items:[]}));
  const {result}=renderHook(()=>useSimulation());
  await waitFor(()=>expect(result.current.topology).not.toBeNull());
  let release!: (t: Envelope<Topology>)=>void;
  tp.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  st.mockResolvedValue(status("new","PAUSED")); sn.mockResolvedValue(snapshot("new"));
  await waitFor(()=>expect(result.current.status?.run_id).toBe("new"), {timeout:2500});
  expect(result.current.topology).toBeNull(); expect(result.current.snapshot).toBeNull();
  await act(async()=>release(topology("new")));
  await waitFor(()=>expect(result.current.snapshot?.run_id).toBe("new"));
});
it("surfaces a failed initial download and recovers on a later successful start", async () => {
  const st=vi.spyOn(api,"status").mockResolvedValue(status("","IDLE","OSM download failed: offline"));
  vi.spyOn(api,"snapshot").mockResolvedValue(snapshot("retry"));
  vi.spyOn(api,"topology").mockResolvedValue(topology("retry"));
  vi.spyOn(api,"news").mockResolvedValue(envelope("retry",{items:[]}));
  const {result}=renderHook(()=>useSimulation());
  await waitFor(()=>expect(result.current.error).toContain("OSM download failed"));
  st.mockResolvedValue(status("retry","RUNNING"));
  await waitFor(()=>expect(result.current.snapshot?.run_id).toBe("retry"), {timeout:2500});
  expect(result.current.error).toBe("");
});
it("asks only now and then while hidden, and at once on return, without a second loop", async () => {
  vi.spyOn(api,"status").mockResolvedValue(status("run","RUNNING"));
  const sn=vi.spyOn(api,"snapshot").mockResolvedValue(snapshot("run"));
  vi.spyOn(api,"topology").mockResolvedValue(topology("run"));
  vi.spyOn(api,"news").mockResolvedValue(envelope("run",{items:[]}));
  const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(true);
  const {result}=renderHook(()=>useSimulation());
  await waitFor(()=>expect(result.current.snapshot?.run_id).toBe("run"));
  const asked=sn.mock.calls.length;
  // Hidden: nothing more for well over the usual second.
  await new Promise(r=>setTimeout(r,1600));
  expect(sn.mock.calls.length).toBe(asked);
  // Back: at once, and then once a second, not twice a second.
  hidden.mockReturnValue(false);
  await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));});
  await waitFor(()=>expect(sn.mock.calls.length).toBe(asked+1));
  await new Promise(r=>setTimeout(r,1300));
  expect(sn.mock.calls.length).toBe(asked+2);
}, 8000);
