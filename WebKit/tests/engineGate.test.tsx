// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/core/api";
import { EngineGate, seenVersion } from "../src/panels/EngineGate";
import type { EngineApproval, EngineIdentity } from "../src/core/types";

const ng: EngineIdentity = { id: "core-ng", version: "0.6.0", kind: "real", channel: "alpha", owns: [], shared: ["physics step"], changes: ["0.6.0: its own compiler."] };
const legacy: EngineIdentity = { id: "core-legacy", version: "3.5.0", kind: "real", channel: "stable", owns: [], shared: [], changes: [] };
const pending = (acknowledge_in: "observer" | "launcher" = "observer"): EngineApproval => ({
  state: "pending", revision: 1, alternatives: [legacy],
  approval: { id: "a1", engine: ng, seed: "42", requested_at: "", acknowledge_in, decision: "", then: "", reason: "" },
});

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** A button of the gate, once the box has formed (its particles have gathered) and it can be pressed. */
async function ready(text: string) {
  const button = (await screen.findByText(text)) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

it("asks, above everything, only once the interface is ready, and says what changed in a version new to this browser", async () => {
  vi.spyOn(api, "engineApproval").mockResolvedValue({ data: pending() });
  const open = vi.fn();
  const { rerender } = render(<EngineGate ready={false} onOpenChange={open} />);
  await act(async () => {});
  expect(screen.queryByRole("alertdialog")).toBeNull();
  rerender(<EngineGate ready onOpenChange={open} />);
  await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
  expect(open).toHaveBeenLastCalledWith(true);
  expect(screen.getByText(/core-ng 0.6.0 is not yet a stable engine/)).toBeTruthy();
  expect(screen.getByText("0.6.0: its own compiler.")).toBeTruthy();
});

it("accepting records the decision on the server, and the version as seen here", async () => {
  vi.spyOn(api, "engineApproval").mockResolvedValue({ data: pending() });
  const decide = vi.spyOn(api, "decideEngine").mockResolvedValue({ data: { state: "accepted", revision: 2 } });
  render(<EngineGate ready onOpenChange={() => {}} />);
  fireEvent.click(await ready("Accept the risk and start"));
  await waitFor(() => expect(decide).toHaveBeenCalledWith("a1", "accept", "", ""));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(seenVersion("core-ng")).toBe("0.6.0");
});

it("rejecting offers the stable engines for the seed alone, starting nothing, or ending the session", async () => {
  vi.spyOn(api, "engineApproval").mockResolvedValue({ data: pending() });
  const decide = vi.spyOn(api, "decideEngine").mockResolvedValue({ data: { state: "rejected", revision: 2 } });
  render(<EngineGate ready onOpenChange={() => {}} />);
  fireEvent.click(await ready("Reject"));
  expect(screen.getByText(/only the seed/)).toBeTruthy();
  expect(screen.getByText("End the session")).toBeTruthy();
  fireEvent.click(screen.getByText("Start the seed on core-legacy 3.5.0 (stable)"));
  await waitFor(() => expect(decide).toHaveBeenCalledWith("a1", "reject", "regenerate", "core-legacy"));
});

it("leaves an acknowledgment set to the launcher to the launcher", async () => {
  vi.spyOn(api, "engineApproval").mockResolvedValue({ data: pending("launcher") });
  render(<EngineGate ready onOpenChange={() => {}} />);
  await act(async () => {});
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("announces a new stable version once, needing no answer", async () => {
  vi.spyOn(api, "engineApproval").mockResolvedValue({ data: { state: "none", revision: 0 } });
  localStorage.setItem("dstns.engine-versions-seen", JSON.stringify({ "core-legacy": "3.4.0" }));
  const { unmount } = render(<EngineGate ready running={legacy} onOpenChange={() => {}} />);
  expect(await screen.findByText("Engine updated")).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  unmount();
  render(<EngineGate ready running={legacy} onOpenChange={() => {}} />);
  await act(async () => {});
  expect(screen.queryByText("Engine updated")).toBeNull();
});
