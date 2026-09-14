import { describe, expect, it } from 'vitest';
import { fitGeographicPoint, longitudeScaleAt } from '../src/mapProjection';

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
