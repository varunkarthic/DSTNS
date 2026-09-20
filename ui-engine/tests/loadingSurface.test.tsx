import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LoadingSurface } from "../src/LoadingSurface";
afterEach(cleanup);
it("uses the favicon D with a separate progress ring",()=>{
  const {container}=render(<LoadingSurface mode="boot" title="Downloading map" reduceMotion={false} />);
  expect(container.querySelector('.loading-favicon')).toHaveAttribute('src', '/favicon.svg');
  expect(container.querySelectorAll('.loading-ring svg')).toHaveLength(1);
  expect(screen.queryByRole('progressbar')).toBeNull();
});
it("shows only measured progress and honors reduced motion",()=>{
  const {container}=render(<LoadingSurface mode="overlay" title="Downloading map" progress={.42} reduceMotion />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow','42');
  expect(container.querySelector('.loading-surface')).toHaveClass('still');
});
