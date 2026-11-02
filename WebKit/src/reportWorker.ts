// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { buildReport } from "./report";
import type { ReportInput, ReportResources } from "./report";
import { coverMap } from "./reportCover";
import { printMap } from "./reportMap";

/** Puts the report together away from the page, so that the interface goes on moving meanwhile. */
self.onmessage = async ({ data }: MessageEvent<{ input: ReportInput; resources: ReportResources }>) => {
  try {
    const { input, resources } = data;
    self.postMessage({ type: "progress", label: "Gathering the run", share: 0.02 });
    const [map, cover] = await Promise.all([printMap(input.topology, input.snapshot.data, input.layers).catch(() => null), coverMap(input.topology, input.snapshot.data, input.snapshot.clock.virtual_day_seconds).catch(() => null)]);
    const { pdf } = await buildReport(input, { ...resources, map, cover, now: new Date() }, (label, share) => self.postMessage({ type: "progress", label, share }));
    const bytes = pdf.output("arraybuffer") as ArrayBuffer;
    (self as unknown as Worker).postMessage({ type: "done", bytes }, [bytes]);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
