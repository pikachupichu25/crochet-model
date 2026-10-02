// The model (FR-4.x, FR-3.2, FR-3.5): the checked pattern laid out in the
// layout worker and drawn in structure or symbol mode (docs/symbol). Lays out
// again when the code changes; failed rows are left out and the panel says so.

import { applyObjectTransforms, readObjectTransforms, type Dimension, type LegendEntry, type Stitch } from "@crochet-model/core";
import { useEffect, useRef, useState } from "react";
import { layoutClient, setDimension, useCheck } from "../check.ts";
import { guessDimension, parserRowLabel, rowLabel, summarise } from "../pattern.ts";
import { selectRow, useApp } from "../store.ts";
import { ModelView, type ColorMode, type ViewMode } from "../view/modelView.ts";
import { LayoutCancelled } from "../workers/clients.ts";
import { saveBlob } from "../download.ts";
import { SymbolLegend } from "./SymbolLegend.tsx";

const QUALITY = { draft: 150, normal: 500, fine: 1500 } as const;
type Quality = keyof typeof QUALITY;

interface Progress {
  fraction: number;
  text: string;
}

/** The pattern's first `#` comment, if any, as the chart's title. */
function chartTitle(text: string | undefined): string {
  const comment = text?.split("\n").find((l) => l.trim().startsWith("#"));
  return comment ? comment.replace(/^\s*#\s*/, "") : "Crochet chart";
}

// The view mode the user picked, per dimension (SYM-FR-1.3); unset means the
// default: symbols for 2D, structure for 3D (SYM-FR-1.4).
const MODE_KEY = "view.mode";
type ModeChoice = Partial<Record<Dimension, ViewMode>>;

function readModes(): ModeChoice {
  try {
    return JSON.parse(localStorage.getItem(MODE_KEY) ?? "{}") as ModeChoice;
  } catch {
    return {};
  }
}

function writeModes(modes: ModeChoice) {
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify(modes));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

export function ModelPanel() {
  const check = useCheck((s) => s.check);
  const checking = useCheck((s) => s.checking);
  const override = useCheck((s) => s.dimensionOverride);
  const rows = useApp((s) => s.segmented.rows);
  const translations = useApp((s) => s.translations);
  const selectedRowId = useApp((s) => s.selectedRowId);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const [quality, setQuality] = useState<Quality>("normal");
  const [seed, setSeed] = useState<number | undefined>();
  const [modes, setModes] = useState<ModeChoice>(readModes);
  // Each mode keeps its own colour: symbols default to ink (SYM-FR-4.3).
  const [colors, setColors] = useState<Record<ViewMode, ColorMode>>({ structure: "yarn", symbols: "ink" });
  const [legend, setLegend] = useState<LegendEntry[]>();
  // Symbol overlays (SYM-FR-3.8, 4.6): the 3D surface is on by default.
  const [overlays, setOverlays] = useState({ surface: true, yarnPath: false, rowNumbers: false });
  const [progress, setProgress] = useState<Progress>();
  const [info, setInfo] = useState<string>();
  const [laidOut, setLaidOut] = useState<string>();
  const [hover, setHover] = useState<{ stitch: Stitch; x: number; y: number }>();
  const cancel = useRef<() => void>(undefined);

  const summary = summarise(rows, translations);
  const owners = check?.owners;
  const ownersRef = useRef(owners);
  ownersRef.current = owners;

  useEffect(() => {
    const v = new ModelView(host.current!);
    view.current = v;
    v.onHover = (h) => setHover(h ? { stitch: h.stitch, x: h.x, y: h.y } : undefined);
    v.onLegend = setLegend;
    v.onPick = (stitch) => selectRow(stitch ? ownersRef.current?.[stitch.row] : undefined);
    return () => v.dispose();
  }, []);

  // Lay out whenever the checked code, the seed or the quality changes.
  const layoutKey = check?.result.ok ? `${check.dimension}|${seed}|${quality}|${check.text}` : undefined;
  useEffect(() => {
    if (!check?.result.ok || !check.graph || !layoutKey) return;
    const graph = check.graph;
    const transforms = readObjectTransforms(check.text);
    let retryNote = "";
    setProgress({ fraction: 0, text: "starting" });
    const job = layoutClient.layout(
      check.result.simpleDot!,
      { seed, iterations: QUALITY[quality] },
      (p) => setProgress({ fraction: p.iteration / p.iterations, text: `${retryNote}iteration ${p.iteration} of ${p.iterations}` }),
      (_seed, previous) => (retryNote = `seed ${previous.seedsTried.at(-1)} folded, retrying · `),
      seed === undefined ? undefined : 1,
    );
    cancel.current = job.cancel;
    job.promise
      .then((result) => {
        view.current!.setModel(graph, { ...result, positions: applyObjectTransforms(graph, result.positions, transforms) });
        setLaidOut(layoutKey);
        setInfo(`${graph.stitches.length} stitches · seed ${result.seed} · ${(result.ms / 1000).toFixed(1)} s`);
        setProgress(undefined);
      })
      .catch((e: unknown) => {
        setProgress(undefined);
        setInfo(e instanceof LayoutCancelled ? "Layout stopped." : `Layout failed: ${(e as Error).message}`);
      });
    return () => job.cancel();
    // layoutKey covers everything the layout depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // The selected row's stitches (FR-3.2).
  useEffect(() => {
    const v = view.current;
    if (!v || !check?.graph || !owners) return v?.setSelection([]);
    const ids = selectedRowId ? check.graph.stitches.filter((s) => owners[s.row] === selectedRowId).map((s) => s.id) : [];
    v.setSelection(ids);
    if (ids.length) v.focusSelection();
  }, [selectedRowId, owners, check, laidOut]);

  const dimension = check?.dimension ?? 3;
  const mode: ViewMode = modes[dimension] ?? (dimension === 2 ? "symbols" : "structure");
  const colorMode = colors[mode];
  const chooseMode = (m: ViewMode) => {
    const next = { ...modes, [dimension]: m };
    setModes(next);
    writeModes(next);
  };
  useEffect(() => view.current?.setOptions({ mode, colorMode, ...overlays }), [mode, colorMode, overlays]);
  // Row numbers read as the English labels when the mapping is known.
  useEffect(() => view.current?.setRowLabel((row) => parserRowLabel(row, owners, rows)), [owners, rows]);

  const auto = guessDimension(rows, translations);
  const hoverRow = hover && owners ? rows.find((r) => r.id === owners[hover.stitch.row]) : undefined;
  const stale = laidOut !== layoutKey;
  const error = check && !check.result.ok ? check.result.error : undefined;
  const errorRow = error && check?.errorRowId ? rows.find((r) => r.id === check.errorRowId) : undefined;

  return (
    <section className="model-panel" aria-label="Model">
      <div className="model-head">
        <h2>Model</h2>
        <div className="model-controls">
          <select aria-label="View" value={mode} onChange={(e) => chooseMode(e.target.value as ViewMode)}>
            <option value="structure">Structure</option>
            <option value="symbols">Symbols</option>
          </select>
          <select
            aria-label="Dimension"
            value={override ?? "auto"}
            onChange={(e) => setDimension(e.target.value === "auto" ? undefined : (Number(e.target.value) as Dimension))}
          >
            <option value="auto">Auto ({auto}D)</option>
            <option value="3">3D</option>
            <option value="2">2D</option>
          </select>
          <select aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
            <option value="draft">Draft</option>
            <option value="normal">Normal</option>
            <option value="fine">Fine</option>
          </select>
          <select aria-label="Colour" value={colorMode} onChange={(e) => setColors({ ...colors, [mode]: e.target.value as ColorMode })}>
            {mode === "symbols" && <option value="ink">Ink</option>}
            {mode === "symbols" && <option value="rows">Alternate rows</option>}
            <option value="yarn">Yarn colour</option>
            <option value="type">By stitch</option>
          </select>
          {mode === "symbols" && (
            <details className="symbol-menu">
              <summary className="button small">Show</summary>
              <div className="symbol-menu-body">
                <label className={dimension === 3 ? "" : "disabled"} title="A shaded surface under the symbols; with it off, the far side fades">
                  <input type="checkbox" checked={overlays.surface} disabled={dimension !== 3} onChange={(e) => setOverlays({ ...overlays, surface: e.target.checked })} />
                  Surface (3D)
                </label>
                <label>
                  <input type="checkbox" checked={overlays.rowNumbers} onChange={(e) => setOverlays({ ...overlays, rowNumbers: e.target.checked })} />
                  Row numbers
                </label>
                <label>
                  <input type="checkbox" checked={overlays.yarnPath} onChange={(e) => setOverlays({ ...overlays, yarnPath: e.target.checked })} />
                  Yarn path
                </label>
              </div>
            </details>
          )}
          <button
            className="button small"
            title="Lay out again from another seed: try this when a 3D piece comes out inside-out"
            onClick={() => setSeed((s) => (s ?? 0) + 1)}
            disabled={!check?.result.ok}
          >
            Flip inside-out
          </button>
          <button className="button small" onClick={() => view.current?.fit()}>
            Fit
          </button>
        </div>
      </div>

      {(summary.failed > 0 || summary.questions > 0) && (
        <p className="model-note">
          {summary.failed > 0 && `${summary.failed} failed ${summary.failed === 1 ? "row is" : "rows are"} left out of this model. `}
          {summary.questions > 0 && `${summary.questions} ${summary.questions === 1 ? "row uses" : "rows use"} a best guess until you answer.`}
        </p>
      )}

      <div className={`viewport ${stale && !progress ? "stale" : ""}`} ref={host}>
        {progress && (
          <div className="layout-progress" role="status">
            <div className="bar" style={{ ["--done" as string]: `${progress.fraction * 100}%` }} />
            <span>Laying out · {progress.text}</span>
            <button className="link" onClick={() => cancel.current?.()}>
              Stop
            </button>
          </div>
        )}
        {error && (
          <div className="viewport-message bad">
            <strong>The code does not parse{errorRow ? ` at ${rowLabel(errorRow)}` : ""}.</strong>
            <span>{error.message}</span>
          </div>
        )}
        {!check && !checking && (
          <div className="viewport-message">
            <strong>Nothing to show yet.</strong>
            <span>Pick a sample, or translate a pattern.</span>
          </div>
        )}
        {hover && (
          <div className="tooltip" style={{ left: hover.x - (host.current?.getBoundingClientRect().left ?? 0) + 12, top: hover.y - (host.current?.getBoundingClientRect().top ?? 0) + 12 }}>
            <b>{hover.stitch.type}</b>
            {hoverRow ? ` · ${rowLabel(hoverRow)}` : ` · row ${hover.stitch.row}`}, stitch {hover.stitch.index + 1}
          </div>
        )}
      </div>
      {mode === "symbols" && legend && legend.length > 0 && (
        <SymbolLegend entries={legend} onHighlight={(key) => view.current?.setHighlightKey(key)} />
      )}
      <div className="model-foot">
        <p className="hint">
          {info ?? (checking ? "Checking…" : "")} {owners ? "· Click a stitch to find its row." : ""}
        </p>
        {laidOut && !stale && (
          <div className="model-export">
            <button className="button small" onClick={() => void view.current?.snapshot().then((b) => saveBlob(b, "model.png"))}>
              PNG
            </button>
            {mode === "symbols" && dimension === 2 && (
              <button
                className="button small"
                title="The chart as SVG, one group per stitch, with its legend"
                onClick={() => {
                  const svg = view.current?.exportSvg(chartTitle(check?.text));
                  if (svg) saveBlob(new Blob([svg], { type: "image/svg+xml" }), "chart.svg");
                }}
              >
                SVG chart
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
