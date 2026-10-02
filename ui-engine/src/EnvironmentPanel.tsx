// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { DcmState, EnvironmentInfo } from "./types";

const fixed = (v: number | undefined, digits = 0) => (v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(digits));

/** Compass point of an azimuth, clockwise from north. */
export function compassPoint(azimuth: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * The Sun's path through the representative day: time of day across (sunrise
 * on the east side, sunset on the west), elevation up. The Sun marks where it
 * is now; below the horizon it is drawn hollow.
 */
export function SunPath({ dcm }: { dcm: DcmState }) {
  const w = 260,
    h = 86,
    pad = 10,
    horizon = 62;
  const peak = Math.max(10, ...dcm.sun_path.map((p) => p.elevation_deg));
  const x = (t: number) => pad + (t / 86400) * (w - 2 * pad);
  const y = (el: number) => horizon - (Math.max(-15, el) / peak) * (horizon - pad);
  const above = dcm.sun_path.filter((p) => p.elevation_deg >= 0);
  const path = dcm.sun_path.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.elevation_deg).toFixed(1)}`).join(" ");
  const now = dcm.updated_s % 86400;
  const sx = x(now),
    sy = y(dcm.elevation_deg);
  return (
    <svg className="sun-path" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Sun path: elevation ${fixed(dcm.elevation_deg, 1)} degrees, azimuth ${fixed(dcm.azimuth_deg)} degrees`} data-testid="sun-path">
      <line x1={pad} x2={w - pad} y1={horizon} y2={horizon} className="sun-horizon" />
      <path d={path} className="sun-arc" />
      {above.length > 0 && <text x={x(above[0].t)} y={horizon + 13} className="sun-label" textAnchor="middle">East</text>}
      {above.length > 0 && <text x={x(above[above.length - 1].t)} y={horizon + 13} className="sun-label" textAnchor="middle">West</text>}
      <circle cx={sx} cy={sy} r={6} className={dcm.daylight ? "sun-disc" : "sun-disc night"} data-testid="sun-marker" />
    </svg>
  );
}

function Figure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="env-figure">
      <span>{label}</span>
      <b className="mono">
        {value}
        {unit && <small> {unit}</small>}
      </b>
    </div>
  );
}

/**
 * The coupled environment, one card per module. Values are simulated or
 * derived and are labelled as such; imported data says where it came from.
 */
export function EnvironmentView({ environment }: { environment: EnvironmentInfo | null }) {
  if (!environment) return <p className="env-empty">The environment appears once a world is loaded.</p>;
  const dcm = environment.state?.dcm;
  const terrain = environment.terrain;
  return (
    <div className="env-cards">
      {dcm && (
        <section className="env-card" aria-label="Sun and surface" data-testid="dcm-card">
          <header>
            <span className="env-title">Sun and surface</span>
            <span className={`tag ${dcm.daylight ? "amber" : "grey"}`}>{dcm.daylight ? "Daylight" : "Night"}</span>
          </header>
          <SunPath dcm={dcm} />
          <div className="env-grid">
            <Figure label="Elevation" value={fixed(dcm.elevation_deg, 1)} unit="°" />
            <Figure label="Azimuth" value={`${fixed(dcm.azimuth_deg)}° ${compassPoint(dcm.azimuth_deg)}`} />
            <Figure label="Direct normal" value={fixed(dcm.direct_normal_w_m2)} unit="W/m²" />
            <Figure label="Mean at surface" value={fixed(dcm.irradiance_w_m2?.mean)} unit="W/m²" />
            <Figure label="Air" value={fixed(dcm.air_temperature_c, 1)} unit="°C" />
            <Figure
              label="Surface"
              value={dcm.surface_temperature_c ? `${fixed(dcm.surface_temperature_c.min, 1)}–${fixed(dcm.surface_temperature_c.max, 1)}` : "–"}
              unit="°C"
            />
          </div>
          <p className="env-note">
            Simulated for a representative day of the month (day {dcm.representative_day_of_year} of the year); cloud cover {fixed(dcm.cloud_mean * 100)}%.
            Surfaces are treated as {dcm.surface.class}.
          </p>
        </section>
      )}
      {terrain && (
        <section className="env-card" aria-label="Terrain" data-testid="terrain-card">
          <header>
            <span className="env-title">Terrain</span>
            <span className={`tag ${terrain.degraded ? "amber" : terrain.observed ? "mint" : "grey"}`}>
              {terrain.degraded ? "Degraded" : terrain.observed ? "Imported" : terrain.source === "synthetic" ? "Synthetic" : "Flat"}
            </span>
          </header>
          <div className="env-grid">
            <Figure label="Lowest" value={fixed(terrain.elevation_min_m, 1)} unit="m" />
            <Figure label="Highest" value={fixed(terrain.elevation_max_m, 1)} unit="m" />
            <Figure label="Steepest road" value={fixed((environment.roads?.max_abs_grade ?? 0) * 100, 1)} unit="%" />
            <Figure label="Grid" value={`${terrain.grid.width}×${terrain.grid.height}`} unit={`@ ${fixed(terrain.grid.cell_m)} m`} />
          </div>
          <p className="env-note">{terrain.observed ? terrain.dataset : terrain.note || "No elevation model in use."}</p>
        </section>
      )}
    </div>
  );
}
