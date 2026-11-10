// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { jsPDF } from "jspdf";
import { drawIllustration, type Illustration } from "./reportIllustrations";

/**
 * A small flowing-layout engine over jsPDF.
 *
 * Content is appended top to bottom. Every block measures itself first and
 * moves to a new page when it would cross the bottom margin, so nothing is
 * clipped or overlapped. Headings keep with the content that follows them,
 * tables repeat their header row on every page they span, and charts are
 * placed whole.
 *
 * Every drawn text line and graphic is recorded with its page and rectangle.
 * The report tests use that record to prove no two text boxes overlap and that
 * everything stays inside the page.
 */

export const PRINT = {
  page: "#ffffff",
  ink: "#0f1d27",
  dim: "#4b5c68",
  faint: "#7b8a95",
  rule: "#d3dbe1",
  panel: "#f2f5f7",
  accent: "#0a7f9e",
  accentSoft: "#dff2f7",
  mint: "#0d8f6b",
  amber: "#b86e00",
  red: "#c0303a",
  blue: "#2f6fc0",
  violet: "#6a4fc2",
  dark: "#071420",
  darkInk: "#dfeaf3",
} as const;

export const SERIES = [PRINT.accent, PRINT.amber, PRINT.violet, PRINT.mint, PRINT.red, PRINT.blue];

export interface LayoutBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "text" | "chrome" | "graphic" | "image";
  text?: string;
}

export const PT = 0.3528; // millimetres per point
export const lineHeight = (size: number) => size * PT * 1.32;

export type Provenance = "Observed" | "Derived" | "Interpretation";

export interface Column {
  title: string;
  /** Fraction of the content width. */
  width: number;
  align?: "left" | "right";
  mono?: boolean;
}

export interface Series {
  name: string;
  points: { x: number; y: number }[];
  color?: string;
  /** Draw as steps (value holds until the next point). */
  step?: boolean;
}

export interface ChartSpec {
  title: string;
  question?: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  xDomain?: [number, number];
  yDomain?: [number, number];
  xTick: (v: number) => string;
  /** Explicit x tick positions, for axes with natural units such as hours. */
  xTicks?: number[];
  yTick?: (v: number) => string;
  height?: number;
  /** Shaded vertical bands, such as backpressure intervals. */
  bands?: { from: number; to: number; color: string; label?: string }[];
}

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < 1e-9) {
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.5 : 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // The smallest 1, 2 or 5 multiple at least as large as the raw step.
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(Math.round(v / step) * step);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

export class ReportDocument {
  readonly W = 210;
  readonly H = 297;
  readonly M = 16;
  readonly top = 26;
  readonly bottom = 297 - 20;
  readonly boxes: LayoutBox[] = [];
  readonly outline: { title: string; page: number; number: string; part?: boolean }[] = [];
  page = 0;
  y = 26;
  private section = 0;
  private sub = 0;
  private parts = 0;
  /** Just under a part's opening band, which already separates what follows. */
  private opened = false;
  /** Headings waiting to see whether what they introduce fits under them. */
  private held: { height: number; draw: () => void }[] = [];

  constructor(readonly pdf: jsPDF, readonly font = "Inter") {}

  get width() {
    return this.W - this.M * 2;
  }

  // ---- Pages ---------------------------------------------------------------

  newPage() {
    if (this.page > 0) this.pdf.addPage();
    this.page = this.pdf.getNumberOfPages();
    this.y = this.top;
  }

  /** Start a new page unless `h` millimetres still fit on this one. */
  ensure(h: number) {
    if (this.y + h > this.bottom) this.newPage();
  }

  space(h: number) {
    this.y += h;
  }

  get remaining() {
    return this.bottom - this.y;
  }

  /**
   * Places any headings still waiting, together with the first `need` mm of what they
   * introduce. If they will not fit, they all go to the next page, so that a title is never
   * left at the foot of a page with its content on the next.
   */
  private start(need: number) {
    const headings = this.held.reduce((sum, h) => sum + h.height, 0);
    if (this.y + headings + need > this.bottom && this.y > this.top + 0.5) this.newPage();
    const waiting = this.held;
    this.held = [];
    for (const heading of waiting) heading.draw();
  }

  /**
   * What must share a page with its heading, for a block `total` mm long that can break after
   * `least` mm. A block that would mostly land on the next page goes there whole, if it fits.
   */
  private keep(total: number, least: number) {
    const headings = this.held.reduce((sum, h) => sum + h.height, 0);
    const room = this.bottom - this.y - headings;
    return total <= this.bottom - this.top - headings && room < total * 0.6 ? total : Math.min(total, least);
  }

  /** Whatever is still waiting, at the end of a document. */
  flush() {
    this.start(0);
  }

  // ---- Primitives ------------------------------------------------------------

  private style(size: number, color: string) {
    this.pdf.setFont(this.font, "normal");
    this.pdf.setFontSize(size);
    this.pdf.setTextColor(color);
  }

  textWidth(text: string, size: number) {
    this.style(size, PRINT.ink);
    return this.pdf.getTextWidth(text);
  }

  /** Draw one line with its top at `top`, recording its box. */
  line(text: string, x: number, top: number, size: number, color: string = PRINT.ink, align: "left" | "right" | "center" = "left", kind: LayoutBox["kind"] = "text") {
    this.style(size, color);
    const w = this.pdf.getTextWidth(text);
    const h = lineHeight(size);
    const baseline = top + size * PT * 0.95;
    this.pdf.text(text, x, baseline, { align });
    const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    this.boxes.push({ page: this.page, x: left, y: top, w, h: size * PT * 1.18, kind, text });
    return h;
  }

  wrap(text: string, width: number, size: number): string[] {
    this.style(size, PRINT.ink);
    return (this.pdf.splitTextToSize(text, width) as string[]).filter((l, i, all) => l.length || i < all.length - 1);
  }

  rule(y = this.y, from = this.M, to = this.W - this.M, color: string = PRINT.rule, width = 0.25) {
    this.pdf.setDrawColor(color);
    this.pdf.setLineWidth(width);
    this.pdf.line(from, y, to, y);
  }

  rect(x: number, y: number, w: number, h: number, fill: string, radius = 1.6) {
    this.pdf.setFillColor(fill);
    if (radius) this.pdf.roundedRect(x, y, w, h, radius, radius, "F");
    else this.pdf.rect(x, y, w, h, "F");
    this.boxes.push({ page: this.page, x, y, w, h, kind: "graphic" });
  }

  // ---- Blocks ---------------------------------------------------------------

  /**
   * Numbered section heading. Starts a new page when less than a third of the
   * current one remains, so a section never opens at the foot of a page and
   * short sections do not leave pages mostly empty.
   */
  sectionHeading(title: string, intro?: string, forceNewPage = false, illustration?: Illustration) {
    this.flush();
    if (forceNewPage || this.page === 0) this.newPage();
    this.section += 1;
    this.sub = 0;
    const number = String(this.section);
    const introLines = intro ? this.wrap(intro, this.width, 9.5).length : 0;
    this.held.push({
      height: 14 + 20 + introLines * lineHeight(9.5) + 4.5,
      draw: () => {
        if (this.y > this.top + 0.5 && !this.opened) {
          this.y += 6;
          this.rule(this.y, this.M, this.W - this.M, PRINT.rule, 0.3);
          this.y += 8;
        }
        const under = this.opened;
        this.opened = false;
        this.outline.push({ title, page: this.page, number });
        // A still drawing of what the section is about, at the right of its title, unless its part's band has one.
        if (illustration && !under) drawIllustration(this.pdf, illustration, this.W - this.M - 38, this.y - 4.5, 38, 22);
        this.line(`SECTION ${number}`, this.M, this.y, 7.5, PRINT.accent);
        this.y += 5;
        this.line(title, this.M, this.y, 18, PRINT.ink);
        this.y += 10;
        this.rect(this.M, this.y, 18, 0.9, PRINT.accent, 0);
        this.y += 5;
        if (intro) this.paragraph(intro, { size: 9.5, color: PRINT.dim });
        this.y += 2;
      },
    });
  }

  /**
   * A part of the report: it always begins a page, under a band that names it and says in a sentence or two what it
   * covers, so that a reader leafing through finds each part where it starts.
   */
  part(title: string, summary: string, illustration?: Illustration) {
    this.flush();
    this.newPage();
    this.parts += 1;
    const numeral = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][this.parts] ?? String(this.parts);
    this.outline.push({ title, page: this.page, number: numeral, part: true });
    const textW = this.width - (illustration ? 58 : 14);
    const lines = this.wrap(summary, textW, 10);
    const h = Math.max(44, 25 + lines.length * lineHeight(10) + 7);
    this.rect(this.M, this.y, this.width, h, PRINT.accentSoft, 3);
    this.rect(this.M, this.y, 2.2, h, PRINT.accent, 0);
    if (illustration) drawIllustration(this.pdf, illustration, this.W - this.M - 48, this.y + (h - 27) / 2, 42, 27);
    this.line(`PART ${numeral}`, this.M + 8, this.y + 7, 7.5, PRINT.accent);
    this.line(title, this.M + 8, this.y + 12, 21, PRINT.ink);
    lines.forEach((l, i) => this.line(l, this.M + 8, this.y + 24 + i * lineHeight(10), 10, PRINT.dim));
    this.y += h + 7;
    this.opened = true;
  }

  /** The one sentence a reader should leave with, set large beside an accent bar. */
  headline(text: string) {
    const size = 13.5;
    const lh = lineHeight(size) * 1.04;
    const lines = this.wrap(text, this.width - 7, size);
    this.start(lines.length * lh + 6);
    this.rect(this.M, this.y + 0.6, 1.4, lines.length * lh - 1.2, PRINT.accent, 0.7);
    lines.forEach((l, i) => this.line(l, this.M + 6, this.y + i * lh, size, PRINT.ink));
    this.y += lines.length * lh + 6;
  }

  /**
   * Numbered findings as cards, two to a row: a short title, what it rests on, and where it comes from. Each pair is
   * as tall as the taller of the two, and a pair is never split across pages.
   */
  insights(items: { title: string; body: string; kind: Provenance }[]) {
    const gap = 4;
    const w = (this.width - gap) / 2;
    const pad = 4.5;
    const textW = w - pad * 2 - 9;
    const measure = (item: (typeof items)[number]) =>
      pad + this.wrap(item.title, textW, 10).length * lineHeight(10) + 1.2 + this.wrap(item.body, textW, 8.6).length * lineHeight(8.6) + 3.5 + lineHeight(6.4) + pad;
    for (let i = 0; i < items.length; i += 2) {
      const pair = items.slice(i, i + 2);
      const h = Math.max(...pair.map(measure));
      if (i === 0) this.start(h + gap);
      this.ensure(h + gap);
      pair.forEach((item, j) => {
        const x = this.M + j * (w + gap);
        const color = item.kind === "Observed" ? PRINT.accent : item.kind === "Derived" ? PRINT.violet : PRINT.amber;
        this.rect(x, this.y, w, h, PRINT.panel, 2.4);
        this.rect(x + pad, this.y + pad, 6, 6, color, 3);
        this.line(String(i + j + 1), x + pad + 3, this.y + pad + 1.15, 8, "#ffffff", "center");
        let y = this.y + pad;
        for (const l of this.wrap(item.title, textW, 10)) {
          this.line(l, x + pad + 9, y, 10, PRINT.ink);
          y += lineHeight(10);
        }
        y += 1.2;
        for (const l of this.wrap(item.body, textW, 8.6)) {
          this.line(l, x + pad + 9, y, 8.6, PRINT.dim);
          y += lineHeight(8.6);
        }
        this.line(item.kind.toUpperCase(), x + pad + 9, this.y + h - pad - lineHeight(6.4), 6.4, color);
      });
      this.y += h + gap;
    }
    this.y += 2;
  }

  /** Shares of a whole as a ring, with each part named, sized and given its share beside it. */
  donut(title: string, rows: { label: string; value: number; color?: string }[], unit = "", question?: string) {
    const parts = rows.filter((r) => r.value > 0);
    const titleH = lineHeight(10) + (question ? lineHeight(8) : 0) + 3;
    const legendH = parts.length * 6.4;
    const h = titleH + Math.max(52, legendH) + 4;
    this.start(h);
    this.ensure(h);
    this.line(title, this.M, this.y, 10, PRINT.ink);
    this.y += lineHeight(10);
    if (question) {
      this.line(this.fit(question, this.width, 8), this.M, this.y, 8, PRINT.dim);
      this.y += lineHeight(8);
    }
    this.y += 3;
    const total = parts.reduce((sum, r) => sum + r.value, 0);
    if (!total) {
      this.line("No records.", this.M, this.y, 8.2, PRINT.dim);
      this.y += lineHeight(8.2) + 3;
      return;
    }
    const R = 24;
    const r = 15;
    const cx = this.M + R + 2;
    const cy = this.y + 26;
    let from = -Math.PI / 2;
    parts.forEach((part, i) => {
      const to = from + (part.value / total) * Math.PI * 2;
      const steps = Math.max(2, Math.ceil(((to - from) / (Math.PI * 2)) * 96));
      const points: [number, number][] = [];
      for (let k = 0; k <= steps; k++) points.push([cx + R * Math.cos(from + ((to - from) * k) / steps), cy + R * Math.sin(from + ((to - from) * k) / steps)]);
      for (let k = steps; k >= 0; k--) points.push([cx + r * Math.cos(from + ((to - from) * k) / steps), cy + r * Math.sin(from + ((to - from) * k) / steps)]);
      const deltas = points.slice(1).map(([x, y], k) => [x - points[k][0], y - points[k][1]]);
      this.pdf.setFillColor(part.color ?? SERIES[i % SERIES.length]);
      this.pdf.lines(deltas, points[0][0], points[0][1], [1, 1], "F", true);
      from = to;
    });
    this.boxes.push({ page: this.page, x: cx - R, y: cy - R, w: R * 2, h: R * 2, kind: "graphic" });
    const totalText = `${Math.round(total).toLocaleString()}${unit}`;
    this.line(totalText, cx, cy - 3.6, this.textWidth(totalText, 11) > r * 1.8 ? 8.5 : 11, PRINT.ink, "center");
    this.line("TOTAL", cx, cy + 1.6, 5.8, PRINT.faint, "center");
    const lx = this.M + R * 2 + 14;
    parts.forEach((part, i) => {
      const y = this.y + 4 + i * 6.4;
      this.rect(lx, y + 0.6, 3, 3, part.color ?? SERIES[i % SERIES.length], 0.8);
      this.line(this.fit(part.label, 70, 8.6), lx + 5.5, y, 8.6, PRINT.ink);
      this.line(`${Math.round(part.value).toLocaleString()}${unit}`, this.W - this.M - 18, y, 8.6, PRINT.dim, "right");
      this.line(`${((part.value / total) * 100).toFixed(0)}%`, this.W - this.M, y, 8.6, PRINT.ink, "right");
    });
    this.y += Math.max(52, legendH) + 4;
  }

  /** Subsection heading, which waits to go on the same page as what it introduces. */
  heading(title: string) {
    this.sub += 1;
    const label = `${this.section}.${this.sub}  ${title}`;
    this.held.push({
      height: 3 + lineHeight(12) + 1.5,
      draw: () => {
        this.y += 3;
        this.line(label, this.M, this.y, 12, PRINT.ink);
        this.y += lineHeight(12) + 1.5;
      },
    });
  }

  paragraph(text: string, options: { size?: number; color?: string; indent?: number; after?: number } = {}) {
    const size = options.size ?? 9.5;
    const indent = options.indent ?? 0;
    const lines = this.wrap(text, this.width - indent, size);
    const lh = lineHeight(size);
    this.start(this.keep(lines.length * lh, lh * 2));
    for (const l of lines) {
      this.ensure(lh);
      this.line(l, this.M + indent, this.y, size, options.color ?? PRINT.ink);
      this.y += lh;
    }
    this.y += options.after ?? 2.5;
  }

  /** A paragraph labelled with where its content comes from. */
  note(kind: Provenance, text: string) {
    const color = kind === "Observed" ? PRINT.accent : kind === "Derived" ? PRINT.violet : PRINT.amber;
    const tag = kind.toUpperCase();
    const size = 9;
    const tagW = this.textWidth(tag, 6.5) + 4;
    const lines = this.wrap(text, this.width - tagW - 3, size);
    const lh = lineHeight(size);
    this.start(lines.length * lh + 1);
    this.ensure(lines.length * lh + 1);
    this.rect(this.M, this.y + 0.3, tagW, 4.2, color === PRINT.accent ? PRINT.accentSoft : PRINT.panel, 1);
    this.line(tag, this.M + 2, this.y + 0.8, 6.5, color);
    lines.forEach((l, i) => {
      if (i > 0) this.ensure(lh);
      this.line(l, this.M + tagW + 3, this.y, size, PRINT.ink);
      this.y += lh;
    });
    this.y += 2.5;
  }

  bullets(items: string[], size = 9.5) {
    const lh = lineHeight(size);
    const heights = items.map((item) => this.wrap(item, this.width - 6, size).length * lh + 0.8);
    this.start(this.keep(heights.reduce((sum, h) => sum + h, 0), heights.slice(0, 2).reduce((sum, h) => sum + h, 0)));
    for (const item of items) {
      const lines = this.wrap(item, this.width - 6, size);
      lines.forEach((l, i) => {
        this.ensure(lh);
        if (i === 0) this.rect(this.M + 1.2, this.y + lh / 2 - 0.9, 1.4, 1.4, PRINT.accent, 0.7);
        this.line(l, this.M + 5, this.y, size, PRINT.ink);
        this.y += lh;
      });
      this.y += 0.8;
    }
    this.y += 1.5;
  }

  /** Two-column label and value list. Values wrap; labels do not. */
  keyValues(rows: [string, string][], labelWidth = 54) {
    const size = 9;
    const lh = lineHeight(size);
    const heights = rows.map(([, value]) => this.wrap(value || "Not recorded", this.width - labelWidth - 2, size).length * lh + 1.6);
    this.start(this.keep(heights.reduce((sum, h) => sum + h, 0), heights.slice(0, 3).reduce((sum, h) => sum + h, 0)));
    for (const [label, value] of rows) {
      const lines = this.wrap(value || "Not recorded", this.width - labelWidth - 2, size);
      this.ensure(lines.length * lh + 1.6);
      this.line(label, this.M, this.y, 8.5, PRINT.dim);
      lines.forEach((l, i) => this.line(l, this.M + labelWidth, this.y + i * lh, size, PRINT.ink));
      this.y += lines.length * lh + 1.2;
      this.rule(this.y - 0.6, this.M, this.W - this.M, "#e6ebef", 0.2);
      this.y += 0.4;
    }
    this.y += 2;
  }

  /** A row of statistic tiles. */
  tiles(items: { label: string; value: string; note?: string; color?: string }[], perRow = 4) {
    const gap = 4;
    const w = (this.width - gap * (perRow - 1)) / perRow;
    const h = 21;
    this.start(Math.ceil(items.length / perRow) * (h + 3));
    for (let i = 0; i < items.length; i += perRow) {
      this.ensure(h + 3);
      items.slice(i, i + perRow).forEach((t, j) => {
        const x = this.M + j * (w + gap);
        this.rect(x, this.y, w, h, PRINT.panel, 2);
        this.line(t.label.toUpperCase(), x + 3.5, this.y + 3, 6.3, PRINT.faint);
        const valueSize = this.textWidth(t.value, 14) > w - 7 ? 11 : 14;
        this.line(t.value, x + 3.5, this.y + 8, valueSize, t.color ?? PRINT.ink);
        if (t.note) {
          const note = this.fit(t.note, w - 7, 6.8);
          this.line(note, x + 3.5, this.y + 15.2, 6.8, PRINT.dim);
        }
      });
      this.y += h + 3;
    }
    this.y += 1;
  }

  /** Truncate a single line to a width with an ellipsis. */
  fit(text: string, width: number, size: number): string {
    if (this.textWidth(text, size) <= width) return text;
    let t = text;
    while (t.length > 1 && this.textWidth(`${t}…`, size) > width) t = t.slice(0, -1);
    return `${t}…`;
  }

  /**
   * A table that flows across pages. Cells wrap within their column; the
   * header row is repeated at the top of every continuation page.
   */
  table(columns: Column[], rows: string[][], options: { size?: number; caption?: string; empty?: string } = {}) {
    const size = options.size ?? 8.2;
    const lh = lineHeight(size);
    const pad = 1.6;
    const widths = columns.map((c) => c.width * this.width);
    const header = () => {
      const lines = columns.map((c, i) => this.wrap(c.title, widths[i] - pad * 2, 7));
      const h = Math.max(...lines.map((l) => l.length)) * lineHeight(7) + pad * 2;
      this.rect(this.M, this.y, this.width, h, PRINT.dark, 1.2);
      let x = this.M;
      columns.forEach((c, i) => {
        lines[i].forEach((l, k) =>
          this.line(l, c.align === "right" ? x + widths[i] - pad : x + pad, this.y + pad + k * lineHeight(7), 7, PRINT.darkInk, c.align === "right" ? "right" : "left"),
        );
        x += widths[i];
      });
      this.y += h;
    };
    const headerH = Math.max(...columns.map((c, i) => this.wrap(c.title, widths[i] - pad * 2, 7).length)) * lineHeight(7) + pad * 2;
    const captionH = options.caption ? lineHeight(8.5) + 1 : 0;
    const laid = rows.map((row) => {
      const cells = columns.map((_, i) => this.wrap(row[i] ?? "", widths[i] - pad * 2, size));
      return { cells, h: Math.max(1, ...cells.map((c) => c.length)) * lh + pad * 2 };
    });
    const sum = (list: { h: number }[]) => list.reduce((total, row) => total + row.h, 0);
    const body = rows.length ? sum(laid) : lh + pad * 2;
    this.start(this.keep(captionH + headerH + body + 4, captionH + headerH + sum(laid.slice(0, 3)) + (rows.length ? 0 : body)));
    if (options.caption) {
      this.line(options.caption, this.M, this.y, 8.5, PRINT.dim);
      this.y += lineHeight(8.5) + 1;
    }
    if (!rows.length) {
      header();
      this.line(options.empty ?? "No records.", this.M + pad, this.y + pad, size, PRINT.dim);
      this.y += lh + pad * 2 + 3;
      return;
    }
    header();
    laid.forEach(({ cells, h }, r) => {
      // The last rows go over together, rather than one alone on a page of its own.
      const orphaned = laid.length - r === 3 && this.y + sum(laid.slice(r)) > this.bottom;
      if (this.y + h > this.bottom || orphaned) {
        this.newPage();
        header();
      }
      if (r % 2 === 1) this.rect(this.M, this.y, this.width, h, PRINT.panel, 0);
      let x = this.M;
      columns.forEach((c, i) => {
        cells[i].forEach((l, k) =>
          this.line(l, c.align === "right" ? x + widths[i] - pad : x + pad, this.y + pad + k * lh, size, PRINT.ink, c.align === "right" ? "right" : "left"),
        );
        x += widths[i];
      });
      this.y += h;
    });
    this.rule(this.y, this.M, this.W - this.M, PRINT.rule, 0.3);
    this.y += 4;
  }

  /**
   * A line chart with title, axes, units, legend and optional bands. The whole
   * chart is placed on one page.
   */
  lineChart(spec: ChartSpec) {
    const height = spec.height ?? 58;
    const titleH = lineHeight(10) + (spec.question ? lineHeight(8) : 0) + 2;
    const legendH = spec.series.length > 1 ? 6 : 0;
    const total = titleH + height + 12 + legendH + 4;
    this.start(total);
    this.ensure(total);
    const top = this.y;
    this.line(spec.title, this.M, this.y, 10, PRINT.ink);
    this.y += lineHeight(10);
    if (spec.question) {
      this.line(this.fit(spec.question, this.width, 8), this.M, this.y, 8, PRINT.dim);
      this.y += lineHeight(8);
    }
    this.y += 2;

    const all = spec.series.flatMap((s) => s.points);
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const xDomain = spec.xDomain ?? [Math.min(...xs, 0), Math.max(...xs, 1)];
    const yTicks = spec.yDomain ? niceTicks(spec.yDomain[0], spec.yDomain[1]) : niceTicks(Math.min(0, ...ys), Math.max(...ys, 0), 4);
    const yMin = yTicks[0];
    const yMax = yTicks[yTicks.length - 1];
    const yTick = spec.yTick ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)));

    // Room for the y tick labels and the rotated axis title.
    const labelW = Math.max(...yTicks.map((t) => this.textWidth(yTick(t), 6.8))) + 2;
    const plotX = this.M + 6 + labelW;
    const plotW = this.W - this.M - plotX - 2;
    const plotY = this.y + 2;
    const plotH = height;
    const px = (x: number) => plotX + ((x - xDomain[0]) / Math.max(1e-9, xDomain[1] - xDomain[0])) * plotW;
    const py = (y: number) => plotY + plotH - ((y - yMin) / Math.max(1e-9, yMax - yMin)) * plotH;

    this.boxes.push({ page: this.page, x: plotX, y: plotY, w: plotW, h: plotH, kind: "graphic" });
    for (const band of spec.bands ?? []) {
      const a = Math.max(plotX, px(band.from));
      const b = Math.min(plotX + plotW, px(band.to));
      if (b - a <= 0.05) continue;
      this.pdf.setFillColor(band.color);
      this.pdf.rect(a, plotY, Math.max(0.4, b - a), plotH, "F");
    }
    // Grid and y ticks.
    for (const t of yTicks) {
      const y = py(t);
      this.rule(y, plotX, plotX + plotW, t === 0 ? "#b9c4cc" : "#e3e9ed", 0.2);
      this.line(yTick(t), plotX - 1.5, y - lineHeight(6.8) / 2, 6.8, PRINT.faint, "right");
    }
    // X ticks: as many as fit without their labels touching.
    const sample = spec.xTick(xDomain[1]);
    const maxTicks = Math.max(2, Math.floor(plotW / (this.textWidth(sample, 6.8) + 6)));
    const xTicks = (spec.xTicks ?? niceTicks(xDomain[0], xDomain[1], Math.min(6, maxTicks - 1))).filter((t) => t >= xDomain[0] - 1e-9 && t <= xDomain[1] + 1e-9);
    let lastRight = -Infinity;
    for (const t of xTicks) {
      const x = px(t);
      this.pdf.setDrawColor("#b9c4cc");
      this.pdf.setLineWidth(0.2);
      this.pdf.line(x, plotY + plotH, x, plotY + plotH + 1.2);
      const label = spec.xTick(t);
      const w = this.textWidth(label, 6.8);
      const left = Math.min(Math.max(x - w / 2, plotX - 2), plotX + plotW - w);
      if (left < lastRight + 2) continue;
      this.line(label, left, plotY + plotH + 1.8, 6.8, PRINT.faint);
      lastRight = left + w;
    }
    // Axis titles.
    this.pdf.setFontSize(7);
    this.pdf.setTextColor(PRINT.dim);
    this.pdf.text(spec.yLabel, this.M + 2.5, plotY + plotH / 2, { angle: 90, align: "center" });
    this.boxes.push({ page: this.page, x: this.M, y: plotY, w: 3.5, h: plotH, kind: "text", text: spec.yLabel });
    this.line(spec.xLabel, plotX + plotW / 2, plotY + plotH + 6.2, 7, PRINT.dim, "center");

    // Series.
    spec.series.forEach((s, i) => {
      const pts = [...s.points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
      if (!pts.length) return;
      this.pdf.setDrawColor(s.color ?? SERIES[i % SERIES.length]);
      this.pdf.setLineWidth(0.45);
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1];
        const b = pts[k];
        if (s.step) {
          this.pdf.line(px(a.x), py(a.y), px(b.x), py(a.y));
          this.pdf.line(px(b.x), py(a.y), px(b.x), py(b.y));
        } else this.pdf.line(px(a.x), py(a.y), px(b.x), py(b.y));
      }
      if (pts.length === 1) {
        this.pdf.setFillColor(s.color ?? SERIES[i % SERIES.length]);
        this.pdf.circle(px(pts[0].x), py(pts[0].y), 0.6, "F");
      }
    });
    this.y = plotY + plotH + 10;
    if (legendH) {
      let x = plotX;
      spec.series.forEach((s, i) => {
        const w = this.textWidth(s.name, 7) + 9;
        if (x + w > this.W - this.M) return;
        this.rect(x, this.y + 1.2, 4, 1.2, s.color ?? SERIES[i % SERIES.length], 0);
        this.line(s.name, x + 5.5, this.y, 7, PRINT.dim);
        x += w + 3;
      });
      this.y += legendH;
    }
    this.y = Math.max(this.y, top + total - 4) + 4;
  }

  /** Horizontal bars for a categorical distribution. */
  barChart(title: string, rows: { label: string; value: number; color?: string }[], unit = "", question?: string) {
    const size = 8.2;
    const bar = 5.2;
    const gap = 1.8;
    const titleH = lineHeight(10) + (question ? lineHeight(8) : 0) + 2;
    const h = titleH + rows.length * (bar + gap) + 4;
    this.start(Math.min(h, this.bottom - this.top));
    this.ensure(Math.min(h, this.bottom - this.top));
    this.line(title, this.M, this.y, 10, PRINT.ink);
    this.y += lineHeight(10);
    if (question) {
      this.line(this.fit(question, this.width, 8), this.M, this.y, 8, PRINT.dim);
      this.y += lineHeight(8);
    }
    this.y += 2;
    if (!rows.length) {
      this.line("No records.", this.M, this.y, size, PRINT.dim);
      this.y += lineHeight(size) + 3;
      return;
    }
    const labelW = Math.min(60, Math.max(...rows.map((r) => this.textWidth(r.label, size))) + 3);
    const max = Math.max(...rows.map((r) => r.value), 1e-9);
    const valueW = Math.max(...rows.map((r) => this.textWidth(`${r.value.toLocaleString()}${unit}`, size))) + 3;
    const trackW = this.width - labelW - valueW;
    for (const r of rows) {
      this.ensure(bar + gap);
      this.line(this.fit(r.label, labelW - 2, size), this.M, this.y + (bar - lineHeight(size)) / 2 + 0.3, size, PRINT.ink);
      this.rect(this.M + labelW, this.y, trackW, bar, PRINT.panel, 0.8);
      if (r.value > 0) this.rect(this.M + labelW, this.y, Math.max(0.8, (r.value / max) * trackW), bar, r.color ?? PRINT.accent, 0.8);
      this.line(`${r.value.toLocaleString()}${unit}`, this.W - this.M, this.y + (bar - lineHeight(size)) / 2 + 0.3, size, PRINT.dim, "right");
      this.y += bar + gap;
    }
    this.y += 3;
  }

  image(dataUrl: string, aspect: number, maxH = 150, caption?: string) {
    const w = this.width;
    const h = Math.min(maxH, w / aspect);
    const iw = h * aspect;
    this.start(h + (caption ? 10 : 4));
    this.ensure(h + (caption ? 10 : 4));
    const x = this.M + (w - iw) / 2;
    this.pdf.addImage(dataUrl, "PNG", x, this.y, iw, h);
    this.boxes.push({ page: this.page, x, y: this.y, w: iw, h, kind: "image" });
    this.pdf.setDrawColor(PRINT.rule);
    this.pdf.setLineWidth(0.25);
    this.pdf.rect(x, this.y, iw, h, "S");
    this.y += h + 2;
    if (caption) this.paragraph(caption, { size: 8, color: PRINT.dim });
  }
}

/** Every pair of overlapping text boxes, for layout verification. */
export function overlappingText(boxes: LayoutBox[], tolerance = 0.25): [LayoutBox, LayoutBox][] {
  const out: [LayoutBox, LayoutBox][] = [];
  const text = boxes.filter((b) => b.kind === "text" || b.kind === "chrome");
  const byPage = new Map<number, LayoutBox[]>();
  for (const b of text) byPage.set(b.page, [...(byPage.get(b.page) ?? []), b]);
  for (const list of byPage.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w > tolerance && h > tolerance) out.push([a, b]);
      }
  return out;
}

/** Ticks every 3 hours across a virtual day. */
export const DAY_TICKS = Array.from({ length: 9 }, (_, i) => i * 3 * 3600);

/** Round wall-clock ticks (seconds) for a span, at most about seven of them. */
export function wallTicks(spanSeconds: number): number[] {
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  const step = steps.find((s) => spanSeconds / s <= 7) ?? 14400;
  const out: number[] = [];
  for (let v = 0; v <= spanSeconds + 1e-9; v += step) out.push(v);
  return out;
}
