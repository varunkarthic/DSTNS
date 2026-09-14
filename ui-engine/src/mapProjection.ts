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
