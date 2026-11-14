// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * Scrolling regions fade where there is more beyond an edge, and are sharp where there is not. Each region's
 * `data-edge` says which ends fade: "start", "end", "both", or none. It changes only when a region reaches or leaves
 * an end, so scrolling itself does no work on the page: the fade is a still mask the browser moves with the region.
 */
export const EDGE_REGIONS = ".stream, .settings-scroll, .about-scroll, .place-search-results, .place-rows, .layers-scroll, .capsule-body-inner";

export function edgeOf(top: number, height: number, view: number): "" | "start" | "end" | "both" {
  const before = top > 1;
  const after = top + view < height - 1;
  return before && after ? "both" : before ? "start" : after ? "end" : "";
}

export function installEdges(root: Document = document): () => void {
  const dirty = new Set<Element>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const el of dirty) {
      if (!el.isConnected) continue;
      const edge = edgeOf(el.scrollTop, el.scrollHeight, el.clientHeight);
      if ((el.getAttribute("data-edge") ?? "") !== edge) {
        if (edge) el.setAttribute("data-edge", edge);
        else el.removeAttribute("data-edge");
      }
    }
    dirty.clear();
  };
  const mark = (el: Element) => {
    dirty.add(el);
    if (!frame) frame = requestAnimationFrame(flush);
  };
  // A region's size, or its content's, can change without a scroll.
  const sized = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const region = entry.target.matches(EDGE_REGIONS) ? entry.target : entry.target.parentElement;
      if (region) mark(region);
    }
  });
  const watched = new WeakSet<Element>();
  const adopt = (el: Element) => {
    if (watched.has(el)) return;
    watched.add(el);
    sized.observe(el);
    for (const child of el.children) sized.observe(child);
    mark(el);
  };
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node.matches(EDGE_REGIONS)) adopt(node);
    for (const el of node.querySelectorAll(EDGE_REGIONS)) adopt(el);
    // Something added inside a region: its children are watched too, and its ends may have moved.
    const region = node.parentElement?.closest(EDGE_REGIONS);
    if (region) {
      if (node.parentElement === region) sized.observe(node);
      mark(region);
    }
  };
  const added = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
  });
  added.observe(root.body, { childList: true, subtree: true });
  scan(root.body);
  const onScroll = (event: Event) => {
    const el = event.target;
    if (el instanceof Element && watched.has(el)) mark(el);
  };
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    root.removeEventListener("scroll", onScroll, { capture: true });
    added.disconnect();
    sized.disconnect();
    cancelAnimationFrame(frame);
  };
}
