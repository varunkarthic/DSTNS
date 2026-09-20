import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionIcon } from "../src/Icons";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('acknowledges changes once and stays still across unrelated rerenders', () => {
  vi.useFakeTimers(); const {container, rerender}=render(<ActionIcon name="bell" signal={false}/>);
  const icon=()=>container.querySelector('.icon-action'); expect(icon()).not.toHaveClass('playing');
  rerender(<ActionIcon name="bellOff" signal={true}/>); expect(icon()).toHaveClass('playing');
  act(()=>vi.advanceTimersByTime(500)); expect(icon()).not.toHaveClass('playing');
  rerender(<ActionIcon name="bellOff" signal={true}/>); expect(icon()).not.toHaveClass('playing');
});
it('cancels an active animation and never replays it when motion preferences change', () => {
  vi.useFakeTimers(); const {container,rerender}=render(<ActionIcon name="forward" signal={0}/>);
  rerender(<ActionIcon name="forward" signal={1}/>); expect(container.firstChild).toHaveClass('playing');
  rerender(<ActionIcon name="forward" signal={1} reduceMotion/>); expect(container.firstChild).not.toHaveClass('playing');
  rerender(<ActionIcon name="forward" signal={1}/>); expect(container.firstChild).not.toHaveClass('playing');
});
