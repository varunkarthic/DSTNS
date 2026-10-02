// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { AtmosphereSummary, DcmState, DrainageSummary, EnvironmentInfo, HydrologyState } from "./types";

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

const volume = (m3: number) => (m3 >= 10000 ? `${(m3 / 1000).toFixed(1)}k` : m3.toFixed(m3 >= 100 ? 0 : 1));

/** Surface water: what is on the ground, and where every cubic metre went. */
export function WaterCard({ water }: { water: HydrologyState }) {
  const l = water.ledger_m3;
  const flooded = water.flooded_area_m2 > 0;
  return (
    <section className="env-card" aria-label="Surface water" data-testid="water-card">
      <header>
        <span className="env-title">Surface water</span>
        <span className={`tag ${flooded ? "blue" : water.wet_cells ? "mint" : "grey"}`}>{flooded ? "Flooding" : water.wet_cells ? "Wet" : "Dry"}</span>
      </header>
      <div className="env-grid">
        <Figure label="On the ground" value={volume(water.stored_m3)} unit="m³" />
        <Figure label="Deepest" value={fixed(water.max_depth_m, 2)} unit="m" />
        <Figure label="Flooded (>10 cm)" value={fixed(water.flooded_area_m2 / 10000, 2)} unit="ha" />
        <Figure label="Peak rain" value={fixed(water.peak_rain_mm_h, 1)} unit="mm/h" />
      </div>
      <table className="env-ledger" aria-label="Water ledger">
        <tbody>
          <tr><td>Rain</td><td className="mono">+{volume(l.rain)}</td></tr>
          <tr><td>Left the district</td><td className="mono">−{volume(l.boundary_outflow)}</td></tr>
          <tr><td>Open water</td><td className="mono">−{volume(l.open_water)}</td></tr>
          <tr><td>Evaporated</td><td className="mono">−{volume(l.evaporated)}</td></tr>
          <tr><td>Infiltrated</td><td className="mono">−{volume(l.infiltrated)}</td></tr>
          <tr><td>Drained</td><td className="mono">−{volume(l.drained)}</td></tr>
          <tr className="env-ledger-total"><td>Conservation error</td><td className="mono" data-testid="water-error">{water.conservation_error_m3 === 0 ? "0 (exact)" : `${water.conservation_error_m3.toExponential(1)} m³`}</td></tr>
        </tbody>
      </table>
      <p className="env-note">
        Simulated with the {water.scheme} on the {water.solver.startsWith("vulkan") ? "GPU" : "CPU"}; {water.substeps} substep{water.substeps === 1 ? "" : "s"} per {water.interval_s} s step.
        {water.supercritical_cells > 0 && ` ${water.supercritical_cells} cells flow faster than the scheme is accurate for (Froude > 0.5).`}
      </p>
    </section>
  );
}

/** The drainage network: synthetic, and how hard it is working. */
export function DrainageCard({ drains }: { drains: DrainageSummary }) {
  const surcharged = drains.surcharged_nodes > 0;
  return (
    <section className="env-card" aria-label="Drainage" data-testid="drainage-card">
      <header>
        <span className="env-title">Drainage</span>
        <span className={`tag ${surcharged ? "red" : drains.stored_m3 > 0.5 ? "blue" : "grey"}`}>
          {surcharged ? "Surcharged" : drains.stored_m3 > 0.5 ? "Flowing" : "Empty"}
        </span>
      </header>
      <div className="env-grid">
        <Figure label="In the pipes" value={volume(drains.stored_m3)} unit="m³" />
        <Figure label="Discharged" value={volume(drains.outfall_m3)} unit="m³" />
        <Figure label="Peak load" value={fixed(drains.peak_utilisation * 100)} unit="% of capacity" />
        <Figure label="Manholes surcharged" value={`${drains.surcharged_nodes}`} unit={`peak ${drains.peak_surcharged_nodes}`} />
      </div>
      <p className="env-note">
        A synthetic network, not the city's sewers: {drains.pipes.toLocaleString()} pipes ({fixed(drains.pipe_length_m / 1000, 1)} km),{" "}
        {Math.round(drains.inlets).toLocaleString()} inlets and {drains.outfalls} outfalls, sized for {drains.design_rain_mm_h} mm/h.
        {drains.backflow_m3 > 0 && ` ${volume(drains.backflow_m3)} m³ has backed up onto the streets.`}
      </p>
    </section>
  );
}

export function WindCard({ air }: { air: AtmosphereSummary }) {
  const bg = air.background;
  const c = air.canopy;
  const tagged = c.height_tagged + c.levels_tagged;
  return (
    <section className="env-card" aria-label="Wind" data-testid="wind-card">
      <header>
        <span className="env-title">Wind</span>
        <span className={`tag ${bg.speed_mps >= 8 ? "amber" : bg.speed_mps >= 1 ? "blue" : "grey"}`}>
          {bg.speed_mps >= 8 ? "Strong" : bg.speed_mps >= 1 ? `From ${compassPoint(bg.from_deg)}` : "Calm"}
        </span>
      </header>
      <div className="env-grid">
        <Figure label="Above the city" value={fixed(bg.speed_mps, 1)} unit={`m/s from ${fixed(bg.from_deg)}°`} />
        <Figure label="In the streets" value={fixed(air.near_surface_mps.mean, 1)} unit={`m/s, up to ${fixed(air.near_surface_mps.max, 1)}`} />
        <Figure label="Buildings" value={c.buildings.toLocaleString()} unit={`mean ${fixed(c.mean_height_m, 1)} m`} />
        <Figure label="Lattice" value={`${air.lattice.nx}×${air.lattice.ny}×${air.lattice.nz}`} unit={`@ ${fixed(air.lattice.dx_m)} m`} />
      </div>
      <p className="env-note">
        Simulated with a lattice Boltzmann model over the buildings and terrain, solved {air.solves} time{air.solves === 1 ? "" : "s"} so far
        and scaled between solves; {air.climate.belt} at this latitude. Building heights: {tagged.toLocaleString()} mapped, {c.estimated.toLocaleString()}{" "}
        estimated.
      </p>
    </section>
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
      {environment.state?.hydrology && <WaterCard water={environment.state.hydrology} />}
      {environment.state?.drainage && environment.state.drainage.pipes > 0 && <DrainageCard drains={environment.state.drainage} />}
      {environment.state?.atmosphere?.solved && <WindCard air={environment.state.atmosphere} />}
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
