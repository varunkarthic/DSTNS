/**
 * Compact counts for dense readouts: 999, 1.2K, 12.9K, 105K, 1.25M.
 *
 * Below a thousand the exact integer is shown. Thousands keep one decimal
 * until they reach three digits; millions keep two significant decimals, so
 * a figure never grows wider than five characters plus its suffix. A value
 * that rounds up into the next unit is shown in that unit (999,960 is 1M,
 * never 1000K).
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const n = Math.abs(value);
  if (n < 1000) return sign + String(Math.round(n));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, suffix] = units[i];
    const next = units[i - 1];
    if (next && n >= next[0]) continue;
    const scaled = n / size;
    const decimals = suffix === "K" ? (scaled < 100 ? 1 : 0) : scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
    const factor = 10 ** decimals;
    const rounded = Math.round(scaled * factor) / factor;
    if (rounded >= 1000 && next) return sign + `1${next[1]}`;
    return sign + `${trim(rounded.toFixed(decimals))}${suffix}`;
  }
  return sign + String(Math.round(n));
}

function trim(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}
