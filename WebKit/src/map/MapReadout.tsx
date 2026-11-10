// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { forwardRef, useImperativeHandle, useRef } from "react";
import { formatCoordinate, scaleBarFor } from "../core/mapProjection";

export interface MapReadoutHandle {
  cursor: (point: { lat: number; lon: number } | null) => void;
  camera: (scale: number) => void;
}

/**
 * Where the pointer is, and the map's scale: a caption on the map. These change on
 * every pointer move and camera frame, so they are written directly to the page. Had
 * they gone through React, each one would have re-rendered the whole interface.
 */
// Changing the text node, rather than replacing it, leaves the page's structure alone.
function write(el: HTMLElement, text: string) {
  if (el.firstChild) (el.firstChild as Text).data = text;
  else el.textContent = text;
}

export const MapReadout = forwardRef<MapReadoutHandle, { fallback: { lat: number; lon: number } | null }>(function MapReadout({ fallback }, handle) {
  const coordinate = useRef<HTMLSpanElement>(null);
  const mark = useRef<HTMLElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const pointed = useRef(false);
  useImperativeHandle(handle, () => ({
    cursor: (point) => {
      pointed.current = !!point;
      if (!coordinate.current) return;
      const shown = point ?? fallbackRef.current;
      write(coordinate.current, shown ? formatCoordinate(shown.lat, shown.lon) : "No coordinates");
    },
    camera: (scale) => {
      const bar = scaleBarFor(1 / scale);
      if (mark.current) mark.current.style.width = `${Math.round(bar.pixels)}px`;
      if (label.current && label.current.textContent !== bar.label) {
        write(label.current, bar.label);
        label.current.parentElement?.setAttribute("aria-label", `Map scale ${bar.label}`);
      }
    },
  }), []);
  return (
    <div className="map-readout" data-tip-avoid>
      <span className="map-attribution">© OpenStreetMap contributors</span>
      <div className="map-readout-row" data-tutorial="coords">
        <span ref={coordinate} className="mono" aria-label="Pointer coordinates">
          {pointed.current ? undefined : fallback ? formatCoordinate(fallback.lat, fallback.lon) : "No coordinates"}
        </span>
        <span className="map-scale-mark mono" aria-label="Map scale">
          <i ref={mark} />
          <span ref={label} />
        </span>
      </div>
    </div>
  );
});
