import { describe, expect, it } from 'vitest';
import {
  METRES_PER_DEGREE_LAT,
  fitGeographicPoint,
  formatCoordinate,
  longitudeScaleAt,
  mapFitLayout,
  metresToGeographic,
  scaleBarFor,
} from '../src/mapProjection';

describe('geographic road projection', () => {
  it.each([0, 52.52, -33.87, 70])('preserves equal east/north distances at latitude %s', (lat) => {
    const bounds = { minLon: 13.3, maxLon: 13.5, minLat: lat - 0.1, maxLat: lat + 0.1 };
    const origin = fitGeographicPoint(13.4, lat, bounds, 900, 600);
    const east = fitGeographicPoint(13.4 + 0.001 / longitudeScaleAt(lat), lat, bounds, 900, 600);
    const north = fitGeographicPoint(13.4, lat + 0.001, bounds, 900, 600);
    expect(origin.x).toBeCloseTo(450);
    expect(origin.y).toBeCloseTo(300);
    expect(east.x - origin.x).toBeCloseTo(origin.y - north.y, 6);
  });

  it('fits the full road extent inside the viewport', () => {
    const bounds = { minLon: 13.3, maxLon: 13.5, minLat: 52.5, maxLat: 52.55 };
    for (const lon of [bounds.minLon, bounds.maxLon]) {
      for (const lat of [bounds.minLat, bounds.maxLat]) {
        const p = fitGeographicPoint(lon, lat, bounds, 900, 600);
        expect(p.x).toBeGreaterThanOrEqual(49.99);
        expect(p.x).toBeLessThanOrEqual(850.01);
        expect(p.y).toBeGreaterThanOrEqual(49.99);
        expect(p.y).toBeLessThanOrEqual(550.01);
      }
    }
  });
});

describe('metre space and geographic coordinates', () => {
  const origin = { origin_lat: 52.5, origin_lon: 13.4 };

  it('treats one kilometre of model space as one kilometre on the ground', () => {
    // The core stores true metres. Moving 1000 in y_m must move exactly the
    // latitude that 1 km corresponds to, and the same distance east must move
    // a larger longitude span because degrees narrow away from the equator.
    const north = metresToGeographic(0, 1000, origin);
    const east = metresToGeographic(1000, 0, origin);
    expect((north.lat - origin.origin_lat) * METRES_PER_DEGREE_LAT).toBeCloseTo(1000, 6);
    const eastMetres =
      (east.lon - origin.origin_lon) * METRES_PER_DEGREE_LAT * longitudeScaleAt(origin.origin_lat);
    expect(eastMetres).toBeCloseTo(1000, 6);
    expect(east.lon - origin.origin_lon).toBeGreaterThan(north.lat - origin.origin_lat);
  });

  it('round-trips through fitGeographicPoint without drift', () => {
    for (const [x, y] of [[0, 0], [2500, -1800], [-640, 970]]) {
      const geo = metresToGeographic(x, y, origin);
      const back = metresToGeographic(0, 0, origin);
      expect(geo.lat === back.lat && geo.lon === back.lon).toBe(x === 0 && y === 0);
    }
  });

  it('formats coordinates with hemispheres rather than signs', () => {
    expect(formatCoordinate(52.52, 13.405)).toBe('52.5200° N, 13.4050° E');
    expect(formatCoordinate(-33.87, -70.66)).toBe('33.8700° S, 70.6600° W');
  });
});

describe('scale bar', () => {
  it('chooses a round distance near the target width', () => {
    for (const mpp of [0.5, 2, 7.3, 40, 260]) {
      const bar = scaleBarFor(mpp, 96);
      // Always 1, 2 or 5 times a power of ten.
      const mantissa = bar.metres / 10 ** Math.floor(Math.log10(bar.metres));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
      // And drawn at a width the operator can actually read.
      expect(bar.pixels).toBeGreaterThan(30);
      expect(bar.pixels).toBeLessThan(250);
      expect(bar.metres).toBeCloseTo(bar.pixels * mpp, 6);
    }
  });

  it('labels kilometres above a thousand metres', () => {
    expect(scaleBarFor(20).label).toMatch(/km$/);
    expect(scaleBarFor(0.2).label).toMatch(/m$/);
  });

  it('degrades safely before the map has a scale', () => {
    expect(scaleBarFor(0).label).toBe('—');
    expect(scaleBarFor(Number.NaN).pixels).toBe(0);
  });
});

describe('fit layout', () => {
  it('centres the network on the visible map area, not the viewport', () => {
    // With the deck showing, the centre must sit left of the viewport centre.
    const wide = mapFitLayout(1440, 900);
    expect(wide.centerX).toBeCloseTo((1440 - 420) / 2);
    expect(wide.centerX).toBeLessThan(720);
    expect(wide.available).toBe(1440 - 420 - 110);
  });

  it('uses the whole width once the deck is hidden', () => {
    const narrow = mapFitLayout(900, 700);
    expect(narrow.centerX).toBeCloseTo(450);
    expect(narrow.available).toBe(800);
  });

  it('matches the deck width at each breakpoint', () => {
    expect(mapFitLayout(1280, 800).centerX).toBeCloseTo((1280 - 340) / 2);
    expect(mapFitLayout(1281, 800).centerX).toBeCloseTo((1281 - 420) / 2);
    expect(mapFitLayout(1024, 800).centerX).toBeCloseTo(512);
  });

  it('never collapses below a usable width', () => {
    expect(mapFitLayout(1100, 600).available).toBeGreaterThanOrEqual(280);
    expect(mapFitLayout(1030, 600).available).toBeGreaterThanOrEqual(280);
  });
});
