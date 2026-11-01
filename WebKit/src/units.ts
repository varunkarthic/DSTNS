// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/** Sizes in decimal units (MB, 1000) by default, or binary (MiB, 1024) if chosen. */
export type ByteUnits = "decimal" | "binary";

let units: ByteUnits = "decimal";
export const setByteUnits = (next: ByteUnits) => {
  units = next;
};

const SCALES: Record<ByteUnits, { base: number; names: [string, string, string] }> = {
  decimal: { base: 1000, names: ["KB", "MB", "GB"] },
  binary: { base: 1024, names: ["KiB", "MiB", "GiB"] },
};

export function formatBytes(bytes: number, digits = 1): string {
  const { base, names } = SCALES[units];
  if (!Number.isFinite(bytes) || bytes < base) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < base ** 2) return `${(bytes / base).toFixed(0)} ${names[0]}`;
  if (bytes < base ** 3) return `${(bytes / base ** 2).toFixed(digits)} ${names[1]}`;
  return `${(bytes / base ** 3).toFixed(2)} ${names[2]}`;
}

/** The unit a chart of rates up to `peak` bytes per second should use. */
export function rateUnit(peak: number): { unit: string; divisor: number } {
  const { base, names } = SCALES[units];
  return peak >= base ** 2 ? { unit: `${names[1]}/s`, divisor: base ** 2 } : { unit: `${names[0]}/s`, divisor: base };
}
