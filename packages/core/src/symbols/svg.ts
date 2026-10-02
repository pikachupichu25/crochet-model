// A 2D symbol scene as a standalone SVG chart (docs/symbol/SPEC.md §7): one
// group per stitch so a designer can tidy it in a vector editor, a legend
// under the chart, and row labels when asked for.

import { legendEntries, legendIcon } from "./legend.ts";
import type { SymbolScene } from "./scene.ts";

export interface SvgOptions {
  /** CSS colour of each glyph, by its index in `scene.glyphs`. */
  glyphColor(index: number): string;
  /** Text and legend colour. */
  ink: string;
  /** Page colour; none leaves the chart transparent. */
  background?: string;
  /** Row label text; leave out for no row labels. */
  rowLabel?: (row: number) => string;
  /** The SVG's `<title>`. */
  title?: string;
}

/** Stroke width, in yarn units, as the view draws it. */
const LINE_WIDTH = 0.06;
const MARGIN = 2;

export function symbolSvg(scene: SymbolScene, options: SvgOptions): string {
  if (scene.dimension !== 2) throw new Error("SVG charts are for 2D layouts; a 3D view exports as PNG.");
  const u = scene.unit;
  // Layout y points up, SVG y down: flip y everywhere.
  const X = (x: number) => fmt(x);
  const Y = (y: number) => fmt(-y);
  const { min, max } = scene.bounds;
  const left = min[0] - MARGIN * u;
  let right = max[0] + MARGIN * u;
  const top = -max[1] - MARGIN * u;
  const chartBottom = -min[1] + MARGIN * u;

  const out: string[] = [];
  const width = LINE_WIDTH * u;

  // Symbols, one group per stitch.
  const symbols = scene.glyphs.map((g, i) => {
    const color = options.glyphColor(i);
    const parts = g.lines.map((line) => `<path d="${line.map((p, k) => `${k ? "L" : "M"}${X(p[0])} ${Y(p[1])}`).join("")}"/>`);
    for (const d of g.dots) parts.push(`<circle cx="${X(d.at[0])}" cy="${Y(d.at[1])}" r="${fmt(d.radius)}" fill="${attr(color)}" stroke="none"/>`);
    return `<g id="s-${safeId(g.stitchId)}" class="sym sym-${safeId(g.key)}" data-stitch="${attr(g.stitchId)}" stroke="${attr(color)}">${parts.join("")}</g>`;
  });
  out.push(`<g fill="none" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-linejoin="round">${symbols.join("\n")}</g>`);

  // Row labels.
  const font = 0.55 * u;
  if (options.rowLabel) {
    const labels = scene.rowLabels.map(
      (l) => `<text x="${X(l.at[0])}" y="${Y(l.at[1])}" text-anchor="middle" dominant-baseline="central">${text(options.rowLabel!(l.row))}</text>`,
    );
    out.push(`<g class="row-labels" fill="${attr(options.ink)}" font-family="sans-serif" font-size="${fmt(font)}" font-weight="600">${labels.join("")}</g>`);
  }

  // Legend: a column under the chart.
  const entries = legendEntries(scene);
  const lineHeight = 1.6 * u;
  const iconSize = 1.2 * u;
  let y = chartBottom;
  const legend: string[] = [];
  for (const e of entries) {
    const icon = legendIcon(e.key);
    const [x0, y0, x1, y1] = icon.box;
    const k = iconSize / Math.max(x1 - x0, y1 - y0, 1);
    const cx = left + iconSize / 2;
    const cy = y + lineHeight / 2;
    // Icon space is y up, centred on its box.
    const ix = (x: number) => fmt(cx + (x - (x0 + x1) / 2) * k);
    const iy = (v: number) => fmt(cy - (v - (y0 + y1) / 2) * k);
    const paths = icon.lines.map((line) => `<path d="${line.map((p, i) => `${i ? "L" : "M"}${ix(p[0])} ${iy(p[1])}`).join("")}"/>`);
    const dots = icon.dots.map((d) => `<circle cx="${ix(d.at[0])}" cy="${iy(d.at[1])}" r="${fmt(d.radius * k)}" fill="${attr(options.ink)}" stroke="none"/>`);
    const label = `${e.name} (${e.key})${e.fallback ? ", no symbol" : ""} × ${e.count}`;
    legend.push(
      `<g class="legend-entry" data-key="${attr(e.key)}"><g fill="none" stroke="${attr(options.ink)}" stroke-width="${fmt(width)}" stroke-linecap="round">${paths.join("")}${dots.join("")}</g>` +
        `<text x="${fmt(left + iconSize + 0.4 * u)}" y="${fmt(cy)}" dominant-baseline="central">${text(label)}</text></g>`,
    );
    // Rough text width, to keep the legend inside the page.
    right = Math.max(right, left + iconSize + 0.4 * u + label.length * font * 0.55 + MARGIN * u);
    y += lineHeight;
  }
  out.push(`<g class="legend" fill="${attr(options.ink)}" font-family="sans-serif" font-size="${fmt(font)}">${legend.join("\n")}</g>`);
  const bottom = y + MARGIN * u;

  const w = right - left;
  const h = bottom - top;
  const head = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(left)} ${fmt(top)} ${fmt(w)} ${fmt(h)}" width="${fmt((w / u) * 24)}" height="${fmt((h / u) * 24)}">`,
    options.title ? `<title>${text(options.title)}</title>` : "",
    options.background ? `<rect x="${fmt(left)}" y="${fmt(top)}" width="${fmt(w)}" height="${fmt(h)}" fill="${attr(options.background)}"/>` : "",
  ];
  return `${head.filter(Boolean).join("\n")}\n${out.join("\n")}\n</svg>\n`;
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => text(s).replace(/"/g, "&quot;");
/** Stitch ids ("3,12|40") and keys as XML-friendly names. */
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
