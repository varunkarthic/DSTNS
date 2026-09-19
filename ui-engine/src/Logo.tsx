/**
 * The DSTNS mark, inline so it inherits theme colours and can be animated.
 *
 * Kept as a component rather than an <img> because the splash screen animates
 * its parts in sequence, which needs the SVG in the document. The geometry
 * mirrors src/assets/logo.svg; replacing that file means updating this too.
 */
export function Logo({
  size = 32,
  animated = false,
  title = "DSTNS",
}: {
  size?: number;
  animated?: boolean;
  title?: string;
}) {
  return (
    <svg
      className={`dstns-logo${animated ? " animated" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        {/* Unique per instance so two logos on one page cannot clash. */}
        <linearGradient id={`dstns-accent-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#35d7ff" />
          <stop offset="100%" stopColor="#93ffde" />
        </linearGradient>
      </defs>
      <circle
        className="logo-ring"
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke={`url(#dstns-accent-${size})`}
        strokeWidth="2.5"
        strokeDasharray="4 5"
        strokeLinecap="round"
        opacity="0.75"
      />
      <g
        className="logo-approaches"
        fill="none"
        stroke={`url(#dstns-accent-${size})`}
        strokeWidth="4"
        strokeLinecap="round"
      >
        <path d="M32 6 V22" />
        <path d="M32 42 V58" />
        <path d="M6 32 H22" />
        <path d="M42 32 H58" />
      </g>
      <rect
        className="logo-node"
        x="23"
        y="23"
        width="18"
        height="18"
        rx="5"
        fill="#071420"
        stroke={`url(#dstns-accent-${size})`}
        strokeWidth="3"
      />
      <circle className="logo-core" cx="32" cy="32" r="3.5" fill={`url(#dstns-accent-${size})`} />
    </svg>
  );
}
