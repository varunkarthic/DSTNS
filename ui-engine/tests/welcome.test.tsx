import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Welcome, reassurance, BOOT_STEPS, WELCOME_MS } from "../src/Splash";
import { MARK, LOGO } from "../src/logoAsset";

afterEach(cleanup);

describe("start-up copy", () => {
  const total = BOOT_STEPS.length;

  it("reassures rather than reporting, and moves forward with the work", () => {
    expect(reassurance(0, total)).toBe("Getting things ready");
    expect(reassurance(total - 1, total)).toBe("Almost there");
    expect(reassurance(total - 2, total)).toBe("Just a moment");
    expect(reassurance(1, total)).toBe("This will only take a moment");
  });

  it("says nothing reassuring when nothing has been asked for", () => {
    // An idle core is not "getting things ready": there is nothing to get
    // ready, and the screen falls back to naming the state plainly.
    expect(reassurance(1, total, true)).toBe("");
  });

  it("never promises a time", () => {
    for (let step = 0; step < total; step++)
      expect(reassurance(step, total)).not.toMatch(/second|minute|\d/i);
  });

  it("holds the welcome screen long enough to read but not to wait on", () => {
    expect(WELCOME_MS).toBeGreaterThanOrEqual(1000);
    expect(WELCOME_MS).toBeLessThanOrEqual(2000);
  });
});

describe("welcome screen", () => {
  it("names the product and credits the licence", () => {
    render(<Welcome reduceMotion={false} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Starting DSTNS");
    expect(screen.getByText(/Deterministic Spatiotemporal Transport Network Simulator/)).toBeInTheDocument();
    expect(screen.getByText(/AGPL-3.0-or-later/)).toBeInTheDocument();
    expect(screen.getByText(/Varun Karthic/)).toBeInTheDocument();
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
  });

  it("shows the mark alone, not the wordmark", () => {
    const { container } = render(<Welcome reduceMotion={false} />);
    const mark = container.querySelector(".dstns-mark");
    expect(mark).toBeTruthy();
    expect(container.querySelector(".dstns-logo")).toBeNull();
    // The mark is the D on its own: a narrower box than the whole wordmark.
    expect(mark).toHaveAttribute("viewBox", MARK.viewBox);
    expect(MARK.aspect).toBeLessThan(LOGO.aspect / 2);
  });

  it("leaves by dissolving, and stays still when motion is reduced", () => {
    const { container: moving } = render(<Welcome closing reduceMotion={false} />);
    expect(moving.querySelector(".loading-surface")).toHaveClass("closing");
    expect(moving.querySelector(".welcome-mark")).toHaveClass("animated");
    cleanup();
    const { container: still } = render(<Welcome reduceMotion />);
    expect(still.querySelector(".loading-surface")).toHaveClass("still");
    expect(still.querySelector(".welcome-mark")).not.toHaveClass("animated");
  });
});
