// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentView, compassPoint } from "../src/EnvironmentPanel";
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

  it("names compass points", () => {
    expect([0, 90, 180, 270, 359, 202.5].map(compassPoint)).toEqual(["N", "E", "S", "W", "N", "SSW"]);
  });
});
