import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { formatEventTime, formatSimulationTime, localizeTimes } from "./timeFormat";
import type { TimeFormatOptions } from "./timeFormat";

/**
 * Presentation preferences shared across the tree.
 *
 * The time format lives here, and only here, so no component keeps its own
 * copy of the 12/24 hour flag. Components read formatters from the hook and
 * re-render together when the preference changes.
 */

interface TimeFormatValue {
  hour12: boolean;
  toggle: () => void;
}

const TimeFormatContext = createContext<TimeFormatValue>({ hour12: false, toggle: () => {} });

export function TimeFormatProvider({ hour12, onToggle, children }: { hour12: boolean; onToggle: () => void; children: ReactNode }) {
  const value = useMemo(() => ({ hour12, toggle: onToggle }), [hour12, onToggle]);
  return <TimeFormatContext.Provider value={value}>{children}</TimeFormatContext.Provider>;
}

export function useTimeFormat() {
  const { hour12, toggle } = useContext(TimeFormatContext);
  return useMemo(
    () => ({
      hour12,
      toggle,
      time: (seconds: number, options?: TimeFormatOptions) => formatSimulationTime(seconds, hour12, options),
      event: (
        item: { virtual_day_s?: number; virtual_s?: number; simulated_current_time?: string },
        options?: TimeFormatOptions,
      ) => formatEventTime(item, hour12, options),
      text: (value: string) => localizeTimes(value, hour12),
    }),
    [hour12, toggle],
  );
}
