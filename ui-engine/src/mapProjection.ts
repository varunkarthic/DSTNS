export interface GeographicBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export function longitudeScaleAt(latitude: number): number {
  return Math.max(0.000001, Math.cos(latitude * Math.PI / 180));
}

// Local equirectangular projection: longitude degrees get shorter away from the equator.
// One shared fit keeps drawing, hit testing, and inspector focus in the same coordinate space.
export function fitGeographicPoint(
  lon: number, lat: number, bounds: GeographicBounds, width: number, height: number,
): { x: number; y: number } {
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const longitudeScale = longitudeScaleAt(centerLat);
  const spanX = Math.max((bounds.maxLon - bounds.minLon) * longitudeScale, 0.000001);
  const spanY = Math.max(bounds.maxLat - bounds.minLat, 0.000001);
  const scale = Math.min(Math.max(1, width - 100) / spanX, Math.max(1, height - 100) / spanY);
  return {
    x: width / 2 + (lon - centerLon) * longitudeScale * scale,
    y: height / 2 - (lat - centerLat) * scale,
  };
}

// ---------------------------------------------------------------------------
// Metre space <-> geographic coordinates.
//
// The core stores node and edge geometry as true metres from a projection
// origin: a kilometre on the ground is 1000 in x_m/y_m. The canvas scales those
// metres to pixels purely for display, so anything derived for the operator's
// benefit (the coordinate readout, the scale bar) converts back through here
// rather than inventing its own factors.
// ---------------------------------------------------------------------------

export const METRES_PER_DEGREE_LAT = 111320;

export interface ProjectionOrigin {
  origin_lat: number;
  origin_lon: number;
}

export function metresToGeographic(
  x_m: number,
  y_m: number,
  origin: ProjectionOrigin,
): { lat: number; lon: number } {
  return {
    lat: origin.origin_lat + y_m / METRES_PER_DEGREE_LAT,
    lon:
      origin.origin_lon +
      x_m / (METRES_PER_DEGREE_LAT * longitudeScaleAt(origin.origin_lat)),
  };
}

// Format a coordinate the way the operator HUD shows it: absolute value with a
// hemisphere letter, so a negative longitude reads "77.5946 W", not "-77.5946 E".
export function formatCoordinate(lat: number, lon: number, digits = 4): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

// Pick a round distance (1/2/5 x 10^n metres) that occupies a sensible width on
// screen, and report how wide that bar must be drawn.
export function scaleBarFor(
  metresPerPixel: number,
  targetPx = 96,
): { metres: number; pixels: number; label: string } {
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0)
    return { metres: 0, pixels: 0, label: "—" };
  const raw = metresPerPixel * targetPx;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  const metres = step * magnitude;
  return {
    metres,
    pixels: metres / metresPerPixel,
    label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m`,
  };
}

// ---------------------------------------------------------------------------
// Viewport layout for the fit-to-network transform.
//
// The telemetry deck covers the right edge of the workspace, so the network
// must be fitted and centred on the part of the canvas that is actually
// visible, not on the whole viewport. Keeping this in one place stops the
// canvas, the tests that aim real pointer events, and the CSS breakpoints from
// drifting apart; the widths below mirror --deck-width in theme.css.
// ---------------------------------------------------------------------------

export interface MapFitLayout {
  /** Horizontal space available to the network, in pixels. */
  available: number;
  /** Centre of the visible map area, in canvas pixels. */
  centerX: number;
  centerY: number;
}

export function mapFitLayout(width: number, height: number): MapFitLayout {
  // Below 1024px the deck is hidden entirely (see theme.css).
  const deck = width <= 1024 ? 0 : width <= 1280 ? 340 : 420;
  const margin = deck ? 110 : 100;
  return {
    available: Math.max(280, width - deck - margin),
    centerX: (width - deck) / 2,
    // The playback dock occupies the bottom; bias the network above it.
    centerY: (height - 60) / 2,
  };
}
