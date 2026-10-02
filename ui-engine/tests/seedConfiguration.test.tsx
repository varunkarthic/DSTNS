// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const describeSeed = vi.fn();
const generateSeed = vi.fn();
const seedLocations = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    describeSeed: (...a: unknown[]) => describeSeed(...a),
    generateSeed: (...a: unknown[]) => generateSeed(...a),
    seedLocations: (...a: unknown[]) => seedLocations(...a),
  },
}));

import { WorldDialog } from "../src/SeedConfiguration";

const meta = (over: Record<string, unknown> = {}) => ({
  seed: "6515130065813855609",
  location: { city: "Ahmedabad", country: "India", latitude: 23.02, longitude: 72.57 },
  month: 7,
  month_name: "July",
  day: 0,
  day_type: "weekday",
  ...over,
});

describe("the new-world seed panel", () => {
  beforeEach(() => {
    describeSeed.mockReset();
    generateSeed.mockReset();
    seedLocations.mockReset();
    seedLocations.mockResolvedValue({
      data: {
        count: 2,
        items: [
          { index: 114, city: "Ahmedabad", country: "India", slug: "ahmedabad", latitude: 23, longitude: 72.6 },
          { index: 0, city: "London", country: "United Kingdom", slug: "london", latitude: 51.5, longitude: -0.1 },
        ],
      },
    });
  });
  afterEach(cleanup);

  it("draws a fresh seed by default, as it always has", () => {
    const onConfirm = vi.fn();
    render(<WorldDialog onCancel={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("Generate New World?");
    expect(screen.getByRole("radio", { name: "Random seed" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("shows what an entered seed resolves to, and builds that seed", async () => {
    describeSeed.mockResolvedValue({ data: meta({ seed: "42", location: { city: "Dar es Salaam", country: "Tanzania", latitude: -6.8, longitude: 39.2 }, month: 1, month_name: "January", day: 1, day_type: "weekend" }) });
    const onConfirm = vi.fn();
    render(<WorldDialog onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: "Enter seed" }));
    const generate = screen.getByRole("button", { name: "Generate" });
    expect(generate).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "4x2" } });
    expect(screen.getByLabelText("Seed")).toHaveValue("42");
    await waitFor(() => expect(describeSeed).toHaveBeenCalledWith("42"));
    const summary = await screen.findByLabelText("Seed metadata");
    expect(summary).toHaveTextContent("Dar es Salaam, Tanzania");
    expect(summary).toHaveTextContent("January");
    expect(summary).toHaveTextContent("Weekend");
    fireEvent.click(generate);
    expect(onConfirm).toHaveBeenCalledWith("42");
  });

  it("generates a seed under constraints and builds exactly that seed", async () => {
    generateSeed.mockResolvedValue({ data: meta() });
    const onConfirm = vi.fn();
    render(<WorldDialog onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: "Constrained seed" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Ahmedabad, India" })).toBeInTheDocument());
    // Locations are listed alphabetically, after Auto.
    const options = Array.from((screen.getByLabelText("Location") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(["Auto", "Ahmedabad, India", "London, United Kingdom"]);
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Ahmedabad" } });
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Day type"), { target: { value: "weekday" } });
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Seed" }));
    });
    expect(generateSeed).toHaveBeenCalledWith({ location: "Ahmedabad", month: "7", day_type: "weekday" });
    const summary = await screen.findByLabelText("Seed metadata");
    expect(summary).toHaveTextContent("6515130065813855609");
    expect(summary).toHaveTextContent("Ahmedabad, India");
    expect(summary).toHaveTextContent("July");
    expect(summary).toHaveTextContent("Weekday");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(onConfirm).toHaveBeenCalledWith("6515130065813855609");
  });

  it("forgets a generated seed when a constraint changes", async () => {
    generateSeed.mockResolvedValue({ data: meta() });
    render(<WorldDialog onCancel={() => {}} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Constrained seed" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Seed" }));
    });
    expect(generateSeed).toHaveBeenCalledWith({ location: "auto", month: "auto", day_type: "auto" });
    await screen.findByLabelText("Seed metadata");
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2" } });
    expect(screen.queryByLabelText("Seed metadata")).toBeNull();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("reports a search the core refused", async () => {
    generateSeed.mockRejectedValue(new Error("unknown location: Atlantis"));
    render(<WorldDialog onCancel={() => {}} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Constrained seed" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Seed" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("unknown location: Atlantis");
  });
});
