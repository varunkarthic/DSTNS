// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { LOGO, MARK } from "./logoAsset";

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

/**
 * The D on its own, at the size the start-up screen wants it.
 *
 * The same glyph the browser icon uses, cut from the same file, so the tab and
 * the start-up screen always show one mark.
 */
export function Mark({
  size = 88,
  className = "",
  title = "DSTNS",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={`dstns-mark${className ? ` ${className}` : ""}`}
      height={size}
      width={Math.round(size * MARK.aspect)}
      viewBox={MARK.viewBox}
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
      dangerouslySetInnerHTML={{ __html: MARK.body }}
    />
  );
}
