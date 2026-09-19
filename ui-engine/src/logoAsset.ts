import raw from "./assets/logo.svg?raw";

/**
 * The brand mark, taken from `src/assets/logo.svg`.
 *
 * That file is the source of truth and can be replaced wholesale; nothing here
 * hard-codes its geometry. Two things are derived from it at module load:
 *
 *  - **The artwork's true bounds.** Exported logos are usually padded onto a
 *    canvas far larger than the artwork — this one draws a 744x137 wordmark on
 *    a 1265x949 page. Rendered as-is at header size the lettering would be a
 *    few pixels tall, so the viewBox is tightened onto the artwork itself.
 *  - **Which path is the backdrop.** A path covering nearly the whole canvas is
 *    a background plate, not part of the mark. Dropping it lets the logo sit on
 *    any surface instead of carrying a dark rectangle around with it.
 *
 * Both are heuristics over the file's own contents, and both fall back to using
 * the file verbatim if it does not look the way this expects.
 */

interface Parsed {
  /** The SVG's inner markup, backdrop removed. */
  body: string;
  /** viewBox cropped to the artwork. */
  viewBox: string;
  /** Width divided by height of that crop. */
  aspect: number;
}

/** Every coordinate-looking number in a path, as (x, y) pairs. */
function bounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  // Bounds from absolute coordinate pairs are valid only for these commands.
  // Unsupported replacement artwork retains its declared viewBox verbatim.
  if (/[^MLCZmlcz0-9eE+.,\s-]/.test(d) || /[mlcz]/.test(d)) return null;
  const numbers = d.match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g);
  if (!numbers || numbers.length < 4) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const x = Number(numbers[i]);
    const y = Number(numbers[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function parse(svg: string): Parsed {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  const declared = viewBoxMatch?.[1]?.trim().split(/[\s,]+/).map(Number);
  const page =
    declared && declared.length === 4 && declared.every(Number.isFinite)
      ? { x: declared[0], y: declared[1], w: declared[2], h: declared[3] }
      : null;

  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const fallback: Parsed = {
    body: inner,
    viewBox: page ? `${page.x} ${page.y} ${page.w} ${page.h}` : "0 0 100 100",
    aspect: page ? page.w / page.h : 1,
  };
  if (!page) return fallback;

  const pageArea = page.w * page.h;
  const elements = inner.match(/<path\b[^>]*\/>|<path\b[^>]*>[\s\S]*?<\/path>/g);
  if (!elements?.length || /<(?:g|image|text|rect|circle|ellipse|polygon|polyline|line|use)\b/.test(inner)) return fallback;

  const kept: string[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const element of elements) {
    const d = element.match(/\bd="([^"]+)"/)?.[1];
    const box = d ? bounds(d) : null;
    if (!box) return fallback;
    const area = (box.maxX - box.minX) * (box.maxY - box.minY);
    // A shape filling essentially the whole page is a backdrop plate.
    if (pageArea > 0 && area >= pageArea * 0.95) continue;
    kept.push(element);
    minX = Math.min(minX, box.minX);
    maxX = Math.max(maxX, box.maxX);
    minY = Math.min(minY, box.minY);
    maxY = Math.max(maxY, box.maxY);
  }

  if (!kept.length || !Number.isFinite(minX)) return fallback;

  // A little air so strokes are not clipped at the edge.
  const pad = Math.max((maxX - minX) * 0.02, (maxY - minY) * 0.06);
  const x = minX - pad;
  const y = minY - pad;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;

  return {
    body: kept.join("\n"),
    viewBox: `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`,
    aspect: h > 0 ? w / h : 1,
  };
}

export const LOGO = parse(raw);

/** The file verbatim, for anywhere the backdrop is wanted. */
export const LOGO_RAW = raw;

/** The exact same source-derived artwork used by the UI and PDF exporter. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO.viewBox}" width="${Math.round(LOGO.aspect * 256)}" height="256">${LOGO.body}</svg>`;

/**
 * The mark as a PNG data URL. `tint` recolours the artwork, so the same file
 * serves dark surfaces as drawn and white print pages in a dark ink.
 */
export async function logoPng(tint?: string): Promise<string> {
  const svg = tint ? LOGO_SVG.replace(/fill="#[0-9a-fA-F]{3,8}"/g, `fill="${tint}"`) : LOGO_SVG;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(LOGO.aspect * 256);
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Report logo could not be rendered.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
