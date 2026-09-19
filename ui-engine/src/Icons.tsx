import type { ReactNode } from "react";

/**
 * The interface's icon set.
 *
 * Every glyph is drawn in one 24 unit box with one stroke width and cap style,
 * and is always rendered at an explicit pixel size. Icons never inherit their
 * size from the surrounding layout, so a flex container or a large font cannot
 * stretch them.
 *
 * Sizes: 14 for inline and list icons, 16 for utility controls, 18 for primary
 * controls, 20 for major sidebar actions.
 */

const PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  focus: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
      <circle cx="12" cy="12" r="8" strokeDasharray="2.6 2.6" />
    </>
  ),
  bell: (
    <>
      <path d="M18 9a6 6 0 10-12 0c0 5.5-2 7-2 7h16s-2-1.5-2-7" />
      <path d="M10.3 20a2 2 0 003.4 0" />
    </>
  ),
  bellOff: (
    <>
      <path d="M17.9 9.2A6 6 0 008.6 4" />
      <path d="M6.2 6.4A6 6 0 006 9c0 5.5-2 7-2 7h12" />
      <path d="M10.3 20a2 2 0 003.4 0" />
      <path d="M3 3l18 18" />
    </>
  ),
  motion: (
    <>
      <path d="M3 8h12M3 12h8M3 16h12" />
      <circle cx="19" cy="12" r="2.2" />
    </>
  ),
  motionOff: (
    <>
      <path d="M3 8h6M3 12h4M3 16h6" />
      <circle cx="16" cy="12" r="2.2" />
      <path d="M3 3l18 18" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>
  ),
  back: <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />,
  forward: <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />,
  step: (
    <>
      <path d="M6 6l8 6-8 6V6z" />
      <path d="M18 6v12" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6.5" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.7" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Return to the start: a counter-clockwise arrow closing on a start mark.
  reset: (
    <>
      <path d="M4 12a8 8 0 108-8 8.4 8.4 0 00-5.8 2.4L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M12 8.5V12l2.5 1.5" />
    </>
  ),
  // A new world: two arrows chasing around a circle.
  reroll: (
    <>
      <path d="M20 11a8 8 0 00-14.6-4.4L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0014.6 4.4L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h8" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  power: (
    <>
      <path d="M12 3v8" />
      <path d="M6.4 6.6a8 8 0 1011.2 0" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7 10.5l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 014.8 1c0 1.7-2.4 2.2-2.4 3.7M12 17.2v.2" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
  rain: (
    <>
      <path d="M7 15a4.5 4.5 0 01-.5-9 6 6 0 0111.3 1.7A3.7 3.7 0 0117.5 15H7z" />
      <path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5" />
    </>
  ),
  flood: (
    <>
      <path d="M3 16c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1" />
      <path d="M3 20c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1" />
      <path d="M12 3l-4 7h8l-4-7z" />
    </>
  ),
  incident: (
    <>
      <path d="M12 3.5l9 16H3l9-16z" />
      <path d="M12 10v4.5M12 17v.2" />
    </>
  ),
  signal: (
    <>
      <rect x="8" y="2.5" width="8" height="15" rx="3" />
      <circle cx="12" cy="6.5" r="1.3" />
      <circle cx="12" cy="10" r="1.3" />
      <circle cx="12" cy="13.5" r="1.3" />
      <path d="M12 17.5V21.5" />
    </>
  ),
  network: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 6h10M6 7.8l5 8.4M18 7.8l-5 8.4" />
    </>
  ),
  traffic: (
    <>
      <rect x="4" y="9" width="16" height="7" rx="2" />
      <path d="M6.5 9l1.8-3.5h7.4L17.5 9" />
      <circle cx="8" cy="17.5" r="1.6" />
      <circle cx="16" cy="17.5" r="1.6" />
    </>
  ),
  gauge: (
    <>
      <path d="M4.2 17a9 9 0 1115.6 0" />
      <path d="M12 13l4-4" />
      <circle cx="12" cy="13" r="1.2" />
    </>
  ),
  demand: (
    <>
      <path d="M4 20V10l8-6 8 6v10" />
      <path d="M9.5 20v-5.5h5V20" />
    </>
  ),
  building: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
      <path d="M9 8h1.5M13.5 8H15M9 12h1.5M13.5 12H15M10.5 20.5v-3.5h3v3.5" />
    </>
  ),
  road: <path d="M8 3L5 21M16 3l3 18M12 4v3M12 10.5v3M12 17v3" />,
  label: (
    <>
      <path d="M4 7V5h16v2M12 5v14M9 19h6" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  system: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  panelCollapse: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M15 4.5v15M8.5 9.5L11 12l-2.5 2.5" />
    </>
  ),
  panelExpand: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M15 4.5v15M11 9.5L8.5 12l2.5 2.5" />
    </>
  ),
  vehicle: (
    <>
      <path d="M5 16.5V12l1.8-4.6A2 2 0 018.7 6h6.6a2 2 0 011.9 1.4L19 12v4.5" />
      <path d="M4 12h16v4.5H4z" />
      <path d="M7 16.5V19M17 16.5V19" />
      <circle cx="8" cy="14.2" r=".6" />
      <circle cx="16" cy="14.2" r=".6" />
    </>
  ),
  stack: (
    <>
      <rect x="4" y="4" width="16" height="4.5" rx="1.5" />
      <rect x="4" y="9.75" width="16" height="4.5" rx="1.5" />
      <rect x="4" y="15.5" width="16" height="4.5" rx="1.5" />
    </>
  ),
  news: (
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="2.5" />
      <path d="M8 9h8M8 12.5h8M8 16h5" />
    </>
  ),
  queue: (
    <>
      <path d="M4 6.5h9M4 12h6M4 17.5h9" />
      <circle cx="17" cy="14.5" r="3.5" />
      <path d="M17 12.8v1.9l1.2.8" />
    </>
  ),
  history: (
    <>
      <path d="M4.5 12a7.5 7.5 0 102.2-5.3L4.5 9" />
      <path d="M4.5 4.5V9H9" />
      <path d="M12 8v4.2l2.8 1.8" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10M19.5 4.5L11 13" />
      <path d="M17.5 14v3.5a2 2 0 01-2 2h-9a2 2 0 01-2-2v-9a2 2 0 012-2H10" />
    </>
  ),
  legend: (
    <>
      <rect x="4" y="5" width="4" height="4" rx="1" />
      <rect x="4" y="15" width="4" height="4" rx="1" />
      <path d="M11 7h9M11 17h9" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className = "",
  strokeWidth = 1.8,
}: {
  name: IconName | string;
  size?: 14 | 16 | 18 | 20 | 24 | number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ width: size, height: size, flex: "none" }}
    >
      {PATHS[name] ?? PATHS.info}
    </svg>
  );
}

/** Icon for a notification or stream category. */
export function categoryIcon(category: string): IconName {
  switch (category) {
    case "weather":
      return "rain";
    case "flooding":
      return "flood";
    case "incident":
    case "safety":
      return "incident";
    case "traffic":
      return "traffic";
    case "demand":
      return "demand";
    case "signals":
      return "signal";
    default:
      return "system";
  }
}
