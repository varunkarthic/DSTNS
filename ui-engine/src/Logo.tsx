import { LOGO } from "./logoAsset";

/**
 * The DSTNS mark, rendered from `src/assets/logo.svg`.
 *
 * Inlined rather than referenced through an <img> so it can be cropped to the
 * artwork, stripped of its backdrop, and animated on the splash screen. Height
 * is the control: width follows the artwork's own aspect ratio, so replacing
 * the file with a differently proportioned mark needs no code change.
 */
export function Logo({
  height = 24,
  animated = false,
  title = "DSTNS",
  className = "",
}: {
  height?: number;
  animated?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      className={`dstns-logo${animated ? " animated" : ""}${className ? ` ${className}` : ""}`}
      height={height}
      width={Math.round(height * LOGO.aspect)}
      viewBox={LOGO.viewBox}
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
      dangerouslySetInnerHTML={{ __html: LOGO.body }}
    />
  );
}
