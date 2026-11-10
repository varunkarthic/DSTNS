// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * How long the world being prepared will take, as the server last estimated it, counted down between its reports. The
 * film plans its scenes by it. Null is not known (nothing asked for yet); 0 is ready.
 */
let reported: { seconds: number | null; at: number } = { seconds: null, at: 0 };

/**
 * An estimate that is only a guess (the server waiting on Overpass, with nothing measured yet) counts as not known, so
 * that the film keeps playing through a long download rather than resting on the name for the whole of it.
 */
export function reportEta(seconds: number | null | undefined, confident = true) {
  const value = typeof seconds === "number" && Number.isFinite(seconds) && (confident || seconds === 0) ? Math.max(0, seconds) : null;
  if (value === reported.seconds) return;
  reported = { seconds: value, at: performance.now() };
}

export function remainingEta(): number | null {
  if (reported.seconds === null) return null;
  return Math.max(0, reported.seconds - (performance.now() - reported.at) / 1000);
}
