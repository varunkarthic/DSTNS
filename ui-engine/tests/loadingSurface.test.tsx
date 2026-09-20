import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LoadingSurface } from "../src/LoadingSurface";
afterEach(cleanup);
it("leads the boot screen with the D and a separate progress ring",()=>{
  const {container}=render(<LoadingSurface mode="boot" title="Downloading map" reduceMotion={false} />);
  // The mark is the D cut from the wordmark, drawn inline so it can be
  // animated - not the favicon image the overlay uses.
  expect(container.querySelector('.loading-mark .dstns-mark')).toBeTruthy();
  expect(container.querySelector('.loading-favicon')).toBeNull();
  expect(container.querySelectorAll('.loading-ring svg')).toHaveLength(1);
  expect(screen.queryByRole('progressbar')).toBeNull();
});
it("keeps the favicon inside the ring when floating over the map",()=>{
  // The overlay has no room to lead with the mark, so the ring carries it.
  const {container}=render(<LoadingSurface mode="overlay" title="Generating world" reduceMotion={false} />);
  expect(container.querySelector('.loading-favicon')).toHaveAttribute('src','/favicon.svg');
  expect(container.querySelector('.loading-mark')).toBeNull();
});
it("shows only measured progress and honors reduced motion",()=>{
  const {container}=render(<LoadingSurface mode="overlay" title="Downloading map" progress={.42} reduceMotion />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow','42');
  expect(container.querySelector('.loading-surface')).toHaveClass('still');
});
