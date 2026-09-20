import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Fades the bottom of a scrollable list, and stops when there is nothing left
 * to scroll to.
 *
 * A permanent fade would dim the last row of a short list that is not clipped
 * at all, which says "there is more" when there is not. So the fade is applied
 * only while the list is actually scrolled away from its end, and the element
 * is re-measured when it scrolls, when it resizes and when its contents change.
 *
 * Returns the props to spread onto the scrolling element.
 */
export function useScrollFade<T extends HTMLElement>() {
  // A callback ref also handles lists mounted later inside a popover/portal.
  const [element, ref] = useState<T | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const measure = useCallback(() => {
    setAtEnd(!element || element.scrollHeight - element.scrollTop - element.clientHeight <= 2);
  }, [element]);

  useLayoutEffect(() => {
    if (!element) return;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const observeRows = () => {
      resize?.disconnect();
      resize?.observe(element);
      for (const child of element.children) resize?.observe(child);
      measure();
    };
    observeRows();
    const mutations = new MutationObserver(observeRows);
    mutations.observe(element, { childList: true, characterData: true, subtree: true });
    return () => { resize?.disconnect(); mutations.disconnect(); };
  }, [element, measure]);

  return { ref, className: atEnd ? "scroll-fade at-end" : "scroll-fade", onScroll: measure };
}
