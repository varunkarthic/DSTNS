// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useScrollFade } from "../src/scrollFade";
let height = 100, content = 100, top = 0;
function List({ open = true, rows = 1 }) {
  const scroll = useScrollFade<HTMLDivElement>();
  return open ? <div {...scroll} data-testid="list" tabIndex={0}>{Array.from({length: rows}, (_, i) => <p key={i}>{i}</p>)}</div> : null;
}
function dimensions() {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => top);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); height = content = 100; top = 0; });
it('does not fade a short list', () => { dimensions(); render(<List/>); expect(screen.getByTestId('list')).toHaveClass('at-end'); });
it('measures a list mounted later in a popover', () => {
  dimensions(); content = 400; const {rerender} = render(<List open={false}/>);
  rerender(<List/>); expect(screen.getByTestId('list')).not.toHaveClass('at-end');
});
it('removes the fade at the bottom including fractional scroll positions', () => {
  dimensions(); content = 400; render(<List/>); top = 299.5;
  fireEvent.scroll(screen.getByTestId('list')); expect(screen.getByTestId('list')).toHaveClass('at-end');
  top = 0; fireEvent.scroll(screen.getByTestId('list')); expect(screen.getByTestId('list')).not.toHaveClass('at-end');
});
it('remeasures arriving and removed rows without a resize', async () => {
  dimensions(); const {rerender} = render(<List/>); content = 400;
  await act(async () => { rerender(<List rows={5}/>); });
  expect(screen.getByTestId('list')).not.toHaveClass('at-end'); content = 100;
  await act(async () => { rerender(<List rows={1}/>); });
  expect(screen.getByTestId('list')).toHaveClass('at-end');
});
it('responds to resizing and releases observers on unmount', () => {
  let notify = () => {}; const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { notify = cb; } observe() {} disconnect = disconnect; });
  dimensions(); content = 400; const {unmount} = render(<List/>);
  height = 400; act(notify); expect(screen.getByTestId('list')).toHaveClass('at-end');
  disconnect.mockClear(); unmount(); expect(disconnect).toHaveBeenCalled();
});
