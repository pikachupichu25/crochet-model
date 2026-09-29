// M0 harness: validates CrochetPARADE text in the parser worker as you type,
// and lays it out in the layout worker on request. Throwaway UI; the real app
// comes in M3.

import type { Dimension, LayoutResult, ValidationResult } from "@crochet-model/core";
import { LayoutCancelled, LayoutClient, ParserClient } from "./workers/clients.ts";

const EXAMPLES: Record<string, string> = {
  "Amigurumi ball": "ring\n6sc\n6*[sc2inc]\n6*[sc,sc2inc]\n6*[2sc,sc2inc]\n6*[3sc,sc2inc]\n30sc\n30sc\n30sc\n30sc\n6*[3sc,sc2tog]\n6*[2sc,sc2tog]\n6*[sc,sc2tog]\n6*[sc2tog]",
  "Flat swatch (2D)": "15ch,turn\nsk,14sc,turn\n[14sc,turn\n]*8\n14sc",
  "Granny-style round": "4ch,ss@[%,0]\n3ch,2dc@[-1,0],ch,3*[3dc@[-1,0],ch],ss@[%,0]",
  "Label error": "3ch\n3sc\n2*[sc,dc@A]",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pattern = $<HTMLTextAreaElement>("pattern");
const exampleSelect = $<HTMLSelectElement>("example");
const dimensionSelect = $<HTMLSelectElement>("dimension");
const statusEl = $("status");
const parseTimeEl = $("parseTime");
const messageEl = $("message");
const rowsEl = $<HTMLTableElement>("rows");
const layoutButton = $<HTMLButtonElement>("layout");
const cancelButton = $<HTMLButtonElement>("cancel");
const progressEl = $<HTMLProgressElement>("progress");
const layoutInfo = $("layoutInfo");
const seedInput = $<HTMLInputElement>("seed");
const iterationsInput = $<HTMLInputElement>("iterations");
const rotateInput = $<HTMLInputElement>("rotate");
const plot = document.getElementById("plot") as unknown as SVGSVGElement;

const parser = new ParserClient();
const layoutClient = new LayoutClient();

let latest: ValidationResult | undefined;
let lastLayout: LayoutResult | undefined;
let edges: { tail: string; head: string; attach: boolean }[] = [];
let validateSeq = 0;

for (const name of Object.keys(EXAMPLES)) exampleSelect.add(new Option(name, name));
pattern.value = EXAMPLES["Amigurumi ball"]!;

const dimension = () => Number(dimensionSelect.value) as Dimension;

async function validateNow() {
  const seq = ++validateSeq;
  const { result, ms } = await parser.validate(pattern.value, { dimension: dimension() });
  if (seq !== validateSeq) return; // a newer edit is on its way
  latest = result;
  parseTimeEl.textContent = `${ms.toFixed(1)} ms in worker`;
  layoutButton.disabled = !result.ok;
  if (result.ok) {
    statusEl.textContent = "valid";
    statusEl.className = "ok";
    messageEl.textContent = result.warnings.join(" · ");
    const graph = JSON.parse(result.graphJson!) as {
      elements: { type: string; tail?: string; head?: string; color?: string }[];
    };
    edges = graph.elements
      .filter((e) => e.type === "edge")
      .map((e) => ({ tail: e.tail!, head: e.head!, attach: e.color === "red" }));
  } else {
    const e = result.error!;
    statusEl.textContent = `invalid: ${e.kind}`;
    statusEl.className = "bad";
    messageEl.textContent = `${e.message}${e.line ? ` (line ${e.line})` : e.row !== undefined ? ` (row ${e.row})` : ""}`;
  }
  rowsEl.replaceChildren();
  if (result.rows.length) {
    rowsEl.insertAdjacentHTML("beforeend", "<tr><th>row</th><th>line</th><th>stitches</th><th>by type</th></tr>");
    for (const r of result.rows) {
      const tr = rowsEl.insertRow();
      const types = Object.entries(r.byType).map(([t, n]) => `${n} ${t}`).join(", ");
      for (const v of [r.row, r.line ?? "", r.stitches, types]) tr.insertCell().textContent = String(v);
    }
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
pattern.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(validateNow, 150);
});
exampleSelect.addEventListener("change", () => {
  pattern.value = EXAMPLES[exampleSelect.value]!;
  if (exampleSelect.value.includes("2D")) dimensionSelect.value = "2";
  validateNow();
});
dimensionSelect.addEventListener("change", validateNow);

layoutButton.addEventListener("click", async () => {
  if (!latest?.ok) return;
  cancelButton.disabled = false;
  layoutButton.disabled = true;
  progressEl.value = 0;
  layoutInfo.textContent = "starting…";
  const job = layoutClient.layout(
    latest.simpleDot!,
    { seed: Number(seedInput.value), iterations: Number(iterationsInput.value) },
    (p) => {
      progressEl.value = p.iteration / p.iterations;
      layoutInfo.textContent = `attempt ${p.attempt}, iteration ${p.iteration}/${p.iterations}, error ${p.error.toFixed(3)}`;
    },
  );
  cancelButton.onclick = () => job.cancel();
  try {
    lastLayout = await job.promise;
    progressEl.value = 1;
    layoutInfo.textContent = `${Object.keys(lastLayout.positions).length} nodes in ${lastLayout.ms} ms, ${lastLayout.attempts} attempt(s), final error ${lastLayout.finalError?.toFixed(3)}`;
    draw();
  } catch (error) {
    layoutInfo.textContent = error instanceof LayoutCancelled ? "cancelled" : `failed: ${(error as Error).message}`;
  } finally {
    cancelButton.disabled = true;
    layoutButton.disabled = !latest?.ok;
  }
});

rotateInput.addEventListener("input", draw);

/** Orthographic projection after rotating about the vertical axis. */
function draw() {
  plot.replaceChildren();
  if (!lastLayout) return;
  const angle = (Number(rotateInput.value) * Math.PI) / 180;
  const project = ([x = 0, y = 0, z = 0]: number[]): [number, number] =>
    lastLayout!.dimension === 2 ? [x, y] : [x * Math.cos(angle) + z * Math.sin(angle), y];
  const points = new Map<string, [number, number]>();
  for (const [name, p] of Object.entries(lastLayout.positions)) points.set(name, project(p));
  const xs = [...points.values()].map((p) => p[0]);
  const ys = [...points.values()].map((p) => p[1]);
  const pad = 1;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  plot.setAttribute("viewBox", `${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`);
  const ns = "http://www.w3.org/2000/svg";
  for (const e of edges) {
    const a = points.get(e.tail), b = points.get(e.head);
    if (!a || !b) continue;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(a[0])); line.setAttribute("y1", String(-a[1]));
    line.setAttribute("x2", String(b[0])); line.setAttribute("y2", String(-b[1]));
    line.setAttribute("class", e.attach ? "attach" : "yarn");
    line.setAttribute("stroke-width", "0.06");
    plot.append(line);
  }
  for (const [name, [x, y]] of points) {
    if (!/^\d+,\d+\|\d+$/.test(name)) continue; // top nodes only
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(-y));
    dot.setAttribute("r", "0.09"); dot.setAttribute("class", "node");
    plot.append(dot);
  }
}

validateNow();
