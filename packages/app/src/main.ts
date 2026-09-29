// M0 harness: validates CrochetPARADE text in the parser worker as you type,
// and lays it out in the layout worker on request. Throwaway UI; the real app
// comes in M3.

import type { Dimension, StitchGraph, ValidationResult } from "@crochet-model/core";
import { StructureView, type ColorMode } from "./view/structureView.ts";
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
const colorSelect = $<HTMLSelectElement>("colorMode");
const internalInput = $<HTMLInputElement>("internal");
const fitButton = $<HTMLButtonElement>("fit");
const tooltip = $("tooltip");

const parser = new ParserClient();
const layoutClient = new LayoutClient();

let latest: ValidationResult | undefined;
let latestGraph: StitchGraph | undefined;
let validateSeq = 0;

const view = new StructureView($("view"));
view.onHover = (info) => {
  tooltip.hidden = !info;
  if (!info) return;
  const s = info.stitch;
  tooltip.textContent = `${s.type} · row ${s.row}, #${s.index}${s.side ? ` · ${s.side}` : ""}${
    s.workedInto.length ? ` · into ${s.workedInto.map((id) => id.split("|")[0]).join(" + ")}` : ""
  }${s.intoSpace ? " (space)" : ""}`;
  const box = $("view").getBoundingClientRect();
  tooltip.style.left = `${info.x - box.left + 12}px`;
  tooltip.style.top = `${info.y - box.top + 12}px`;
};
colorSelect.addEventListener("change", () => view.setOptions({ colorMode: colorSelect.value as ColorMode }));
internalInput.addEventListener("change", () => view.setOptions({ showInternal: internalInput.checked }));
fitButton.addEventListener("click", () => view.fit());

const exampleGroup = document.createElement("optgroup");
exampleGroup.label = "M0";
for (const name of Object.keys(EXAMPLES)) exampleGroup.append(new Option(name, name));
exampleSelect.append(exampleGroup);
pattern.value = EXAMPLES["Amigurumi ball"]!;

// The examples bundled in parse64.js, as `var textName = \`…\`;` globals.
void import("../../../vendor/crochetparade/parse64.js?raw").then(({ default: source }) => {
  const group = document.createElement("optgroup");
  group.label = "CrochetPARADE examples";
  for (const m of source.matchAll(/^var (text[A-Z]\w*)\s*=\s*`([^`]*)`/gm)) {
    const name = m[1]!.slice(4);
    // Evaluate the literal, so escapes such as `\\` mean what they do in the parser.
    EXAMPLES[name] = new Function(`return \`${m[2]}\`;`)() as string;
    group.append(new Option(name, name));
  }
  exampleSelect.append(group);
});

// A blank box keeps the pattern's own DOT: setting; a number overrides it.
const optionalNumber = (input: HTMLInputElement) => (input.value.trim() === "" ? undefined : Number(input.value));

const dimension = () => Number(dimensionSelect.value) as Dimension;

async function validateNow() {
  const seq = ++validateSeq;
  // Until this pattern is checked, Lay out would use the previous one.
  layoutButton.disabled = true;
  const { result, graph, ms } = await parser.validate(pattern.value, { dimension: dimension(), withGraph: true });
  if (seq !== validateSeq) return; // a newer edit is on its way
  latest = result;
  latestGraph = graph;
  parseTimeEl.textContent = `${ms.toFixed(1)} ms in worker`;
  layoutButton.disabled = !result.ok;
  if (result.ok) {
    statusEl.textContent = "valid";
    statusEl.className = "ok";
    messageEl.textContent = result.warnings.join(" · ");
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
  // CrochetPARADE's examples choose their own look; M0's flat swatch is 2D.
  dimensionSelect.value = exampleSelect.value.includes("2D") ? "2" : "3";
  validateNow();
});
dimensionSelect.addEventListener("change", validateNow);

layoutButton.addEventListener("click", async () => {
  if (!latest?.ok || !latestGraph) return;
  const graph = latestGraph;
  cancelButton.disabled = false;
  layoutButton.disabled = true;
  progressEl.value = 0;
  layoutInfo.textContent = "starting…";
  const seed = optionalNumber(seedInput);
  let retryNote = "";
  const job = layoutClient.layout(
    latest.simpleDot!,
    { seed, iterations: optionalNumber(iterationsInput) },
    (p) => {
      progressEl.value = p.iteration / p.iterations;
      layoutInfo.textContent = `${retryNote}seed ${p.seed}, attempt ${p.attempt}, iteration ${p.iteration}/${p.iterations}, error ${p.error.toFixed(3)}`;
    },
    (_seed, previous) => {
      retryNote = `seed ${previous.seedsTried.at(-1)} folded (${previous.crossings} crossings), retrying · `;
    },
    // A seed typed in the box means that seed, folded or not.
    seed === undefined ? undefined : 1,
  );
  cancelButton.onclick = () => job.cancel();
  try {
    const result = await job.promise;
    progressEl.value = 1;
    const fold = result.fold;
    const foldNote = !fold
      ? ""
      : `, ${fold.crossings}/${fold.edges} edges crossing${fold.folded ? " (still folded)" : ""}${
          fold.seedsTried.length > 1 ? `, tried seeds ${fold.seedsTried.join(", ")}` : ""
        }`;
    layoutInfo.textContent = `${graph.stitches.length} stitches, ${Object.keys(result.positions).length} nodes in ${result.ms} ms, seed ${result.seed}, ${result.attempts} attempt(s), final error ${result.finalError?.toFixed(3)}${foldNote}`;
    view.setModel(graph, result);
  } catch (error) {
    layoutInfo.textContent = error instanceof LayoutCancelled ? "cancelled" : `failed: ${(error as Error).message}`;
  } finally {
    cancelButton.disabled = true;
    layoutButton.disabled = !latest?.ok;
  }
});

validateNow();
