// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DrainageCard, EnvironmentView, WaterCard, WindCard, compassPoint } from "../src/EnvironmentPanel";
import type { HydrologyState } from "../src/types";
import type { EnvironmentInfo } from "../src/types";

const path = Array.from({ length: 97 }, (_, i) => ({ t: i * 900, elevation_deg: 60 * Math.sin(((i * 900 - 6 * 3600) / (12 * 3600)) * Math.PI), azimuth_deg: (i * 900 / 86400) * 360 }));

const environment = (overrides: Partial<EnvironmentInfo["state"]> = {}): EnvironmentInfo => ({
  schema_version: 1,
  terrain: {
    source: "terrarium", provider: "AWS Open Data Terrain Tiles", dataset: "Mapzen/Tilezen Terrarium", licence: "", attribution: "", note: "cache hit",
    observed: true, degraded: false, data_class: "imported", zoom: 13, native_resolution_m: 11.6,
    grid: { width: 108, height: 108, cell_m: 25, origin_x_m: 0, origin_y_m: 0 }, elevation_min_m: 27.5, elevation_max_m: 55.2, hash: "sha256:x",
  },
  roads: { max_abs_grade: 0.11 },
  fields: [],
  state: {
    time_s: 13 * 3600,
    dcm: {
      updated_s: 13 * 3600, interval_s: 60, representative_day_of_year: 198, latitude: 52.5, longitude: 13.4, solar_time_h: 12.3,
      elevation_deg: 59.4, azimuth_deg: 190, daylight: true, direct_normal_w_m2: 840, diffuse_horizontal_w_m2: 84,
      clear_sky_global_horizontal_w_m2: 800, cloud_mean: 0.1, air_temperature_c: 23.5,
      irradiance_w_m2: { min: 700, mean: 780, max: 820 }, surface_temperature_c: { min: 38.2, mean: 44, max: 47.9 },
      sun_path: path, surface: { class: "asphalt (assumed everywhere)", albedo: 0.12, emissivity: 0.93 },
    },
    ...overrides,
  },
});

describe("the City tab", () => {
  afterEach(cleanup);

  it("shows where the Sun is and what it does to the surface", () => {
    render(<EnvironmentView environment={environment()} />);
    const card = screen.getByTestId("dcm-card");
    expect(within(card).getByText("Daylight")).toBeInTheDocument();
    expect(card).toHaveTextContent("59.4");
    expect(card).toHaveTextContent("190° S");
    expect(card).toHaveTextContent("840");
    expect(card).toHaveTextContent("38.2–47.9");
    expect(card).toHaveTextContent("representative day of the month (day 198");
    expect(screen.getByTestId("sun-path")).toHaveAttribute("aria-label", expect.stringContaining("elevation 59.4"));
    expect(screen.getByText("East")).toBeInTheDocument();
    expect(screen.getByText("West")).toBeInTheDocument();
  });

  it("draws the Sun hollow at night", () => {
    const night = environment();
    night.state!.dcm = { ...night.state!.dcm!, daylight: false, elevation_deg: -20, updated_s: 1800 };
    render(<EnvironmentView environment={night} />);
    expect(screen.getByText("Night")).toBeInTheDocument();
    expect(screen.getByTestId("sun-marker")).toHaveClass("night");
  });

  it("says where the terrain came from", () => {
    render(<EnvironmentView environment={environment()} />);
    const card = screen.getByTestId("terrain-card");
    expect(within(card).getByText("Imported")).toBeInTheDocument();
    expect(card).toHaveTextContent("11.0");
    expect(card).toHaveTextContent("Mapzen/Tilezen Terrarium");
  });

  it("waits for a world", () => {
    render(<EnvironmentView environment={null} />);
    expect(screen.getByText(/once a world is loaded/)).toBeInTheDocument();
  });

  it("accounts for every cubic metre of surface water", () => {
    const water: HydrologyState = {
      updated_s: 50000, interval_s: 5, scheme: "local-inertial shallow water", solver: "cpu", substeps: 1, dt_s: 5, cfl_capped: false,
      stored_m3: 1997.8, max_depth_m: 0.26, wet_cells: 420, flooded_cells: 13, flooded_area_m2: 8125, peak_rain_mm_h: 31.4,
      peak_depth_m: 0.26, peak_flooded_area_m2: 8125,
      ledger_m3: { initial: 0, rain: 2353.2, boundary_outflow: 210.4, open_water: 0, evaporated: 61.2, infiltrated: 83.8, drained: 0 },
      conservation_error_m3: 0, conservation_error_relative: 0, max_froude: 0.01, supercritical_cells: 0, refinement_candidates: [],
    };
    render(<WaterCard water={water} />);
    const card = screen.getByTestId("water-card");
    expect(within(card).getByText("Flooding")).toBeInTheDocument();
    expect(card).toHaveTextContent("1998");
    expect(card).toHaveTextContent("0.81");
    expect(within(screen.getByRole("table", { name: "Water ledger" })).getByText("+2353")).toBeInTheDocument();
    expect(screen.getByTestId("water-error")).toHaveTextContent("0 (exact)");
    expect(card).toHaveTextContent("on the CPU");
  });

  it("says the drainage network is synthetic and how hard it is working", () => {
    render(
      <DrainageCard
        drains={{
          source: "synthetic", data_class: "synthetic", inlets: 1820.4, junctions: 1196, pipes: 1188, outfalls: 8, pipe_length_m: 43210,
          design_rain_mm_h: 25, stored_m3: 412.3, inflow_m3: 5000, backflow_m3: 183.6, outfall_m3: 4404, conservation_error_m3: 0,
          surcharged_nodes: 3, full_pipes: 9, peak_utilisation: 2.14, peak_surcharged_nodes: 18,
        }}
      />,
    );
    const card = screen.getByTestId("drainage-card");
    expect(within(card).getByText("Surcharged")).toBeInTheDocument();
    expect(card).toHaveTextContent("A synthetic network, not the city's sewers");
    expect(card).toHaveTextContent("1,188 pipes (43.2 km)");
    expect(card).toHaveTextContent("214");
    expect(card).toHaveTextContent("peak 18");
    expect(card).toHaveTextContent("184 m³ has backed up onto the streets");
  });

  it("gives the wind above the city and in its streets, and where building heights came from", () => {
    render(
      <WindCard
        air={{
          solved: true, solved_s: 3600, updated_s: 3660, solves: 3, solves_skipped: 1, solve_interval_s: 3600, scheme: "lattice Boltzmann",
          solver: "CPU", lattice: { nx: 54, ny: 54, nz: 8, dx_m: 50, cells: 23328 }, iterations: 432, converged: true, max_mach: 0.17,
          background: { speed_mps: 4.2, from_deg: 250 }, climate: { belt: "westerlies", mean_speed_mps: 4.1, prevailing_from_deg: 255 },
          near_surface_mps: { mean: 3.1, max: 5.6 }, reference_height_m: 10,
          canopy: { buildings: 1165, height_tagged: 25, levels_tagged: 605, estimated: 535, built_fraction: 0.1, mean_height_m: 15.1, max_height_m: 368, source: "OpenStreetMap footprints" },
        }}
      />,
    );
    const card = screen.getByTestId("wind-card");
    expect(within(card).getByText("From WSW")).toBeInTheDocument();
    expect(card).toHaveTextContent("4.2");
    expect(card).toHaveTextContent("up to 5.6");
    expect(card).toHaveTextContent("54×54×8");
    expect(card).toHaveTextContent("solved 3 times");
    expect(card).toHaveTextContent("westerlies");
    expect(card).toHaveTextContent("630 mapped, 535 estimated");
  });

  it("names compass points", () => {
    expect([0, 90, 180, 270, 359, 202.5].map(compassPoint)).toEqual(["N", "E", "S", "W", "N", "SSW"]);
  });
});
