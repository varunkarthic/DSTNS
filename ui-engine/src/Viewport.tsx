import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { Icon } from "./Icons";

/**
 * Minimum supported viewport.
 *
 * DSTNS is an operator interface for laptop and desktop displays. The command
 * rail alone needs room for transport, the clock, seven speeds, the seed, the
 * runtime status and Terminate; below the size where those fit on one row, and
 * where the map still has usable height beneath the header and above the rail,
 * the interface would be squeezed into something unusable. It says so instead.
 *
 * The figures come from the laid-out interface, not from a round number:
 * the rail measures about 980px at its most compact, plus the tool dock and
 * the page margins; and the map needs roughly 300px of height under the
 * header and above the rail.
 */
export const MIN_WIDTH = 1024;
export const MIN_HEIGHT = 640;

export function viewportTooSmall(width: number, height: number): boolean {
  return width < MIN_WIDTH || height < MIN_HEIGHT;
}

/** Which dimension falls short, for a message that says something useful. */
export function shortfall(width: number, height: number): "width" | "height" | "both" | null {
  const narrow = width < MIN_WIDTH;
  const short = height < MIN_HEIGHT;
  if (narrow && short) return "both";
  if (narrow) return "width";
  if (short) return "height";
  return null;
}

export function useViewportSize(): { width: number; height: number } {
  const read = () => ({
    width: typeof window === "undefined" ? MIN_WIDTH : window.innerWidth,
    height: typeof window === "undefined" ? MIN_HEIGHT : window.innerHeight,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * Shown in place of the interface on a display too small to carry it. It
 * leaves on its own as soon as the window is large enough, so resizing is all
 * the operator has to do.
 */
export function ViewportNotice({ width, height, reduceMotion }: { width: number; height: number; reduceMotion: boolean }) {
  const missing = shortfall(width, height);
  const need =
    missing === "both"
      ? `at least ${MIN_WIDTH} by ${MIN_HEIGHT} pixels`
      : missing === "width"
        ? `at least ${MIN_WIDTH} pixels wide`
        : `at least ${MIN_HEIGHT} pixels tall`;
  return (
    <div className={`viewport-notice${reduceMotion ? " still" : ""}`} role="alert" aria-live="polite">
      <div className="viewport-card">
        <Logo height={30} animated={!reduceMotion} />
        <h1>This interface is not optimized for this screen size.</h1>
        <p>
          DSTNS is built for laptop and desktop displays. The simulation is unaffected and keeps running; the observer
          returns as soon as this window is {need}.
        </p>
        <dl className="viewport-facts">
          <div>
            <dt>This window</dt>
            <dd className={`mono${missing === "width" || missing === "both" ? " short" : ""}`}>
              {Math.round(width)} <span>×</span> {Math.round(height)}
            </dd>
          </div>
          <div>
            <dt>Minimum</dt>
            <dd className="mono">
              {MIN_WIDTH} <span>×</span> {MIN_HEIGHT}
            </dd>
          </div>
        </dl>
        <p className="viewport-hint">
          <Icon name="info" size={14} />
          Enlarge the window, or open DSTNS on a larger display.
        </p>
      </div>
    </div>
  );
}
