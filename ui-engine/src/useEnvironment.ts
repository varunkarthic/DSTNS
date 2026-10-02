// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useState } from "react";
import { api } from "./api";
import { fieldInfo } from "./fields";
import type { FieldOverlay, FieldRaster } from "./fields";
import type { EnvironmentInfo } from "./types";

/** How often a changing field is re-read while it is shown. */
const DYNAMIC_REFRESH_MS = 2000;
const SUMMARY_REFRESH_MS = 2000;

/**
 * The environment summary for the current run, and the raster of the field
 * overlay being shown. A static field (elevation) is read once per run; a
 * changing one is re-read while it is on screen, at display resolution only.
 * Nothing is fetched for an overlay that is off.
 */
export function useEnvironment(runId: string, overlay: FieldOverlay, stateRevision: number) {
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [raster, setRaster] = useState<FieldRaster | null>(null);
  const [error, setError] = useState("");

  // The summary is small; it is re-read every couple of seconds so the Sun,
  // temperatures and (later) water and wind figures stay current.
  useEffect(() => {
    setEnvironment(null);
    if (!runId) return;
    let live = true;
    const read = () => api.environment().then((r) => live && r.run_id === runId && setEnvironment(r.data)).catch(() => {});
    void read();
    const timer = setInterval(read, SUMMARY_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runId]);

  const info = fieldInfo(overlay);
  const available = !!info && !!environment?.fields.some((f) => f.name === info.field);
  // A changing field is re-read on a timer, gated on the state having moved.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!available || !info?.dynamic) return;
    const t = setInterval(() => setTick((n) => n + 1), DYNAMIC_REFRESH_MS);
    return () => clearInterval(t);
  }, [available, info?.dynamic]);
  const generation = info?.dynamic ? `${tick}:${stateRevision > 0 ? 1 : 0}` : "static";

  useEffect(() => {
    if (!available || !info) {
      setRaster(null);
      return;
    }
    let live = true;
    api
      .field(info.field)
      .then((r) => {
        if (!live || r.run_id !== runId) return;
        setRaster(r.data);
        setError("");
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "The field could not be read."));
    return () => {
      live = false;
    };
  }, [available, info, runId, generation]);

  useEffect(() => setRaster(null), [runId, overlay]);

  return { environment, raster: available ? raster : null, available, error };
}
