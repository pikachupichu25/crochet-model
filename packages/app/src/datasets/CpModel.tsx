// A model for CrochetPARADE text on its own, outside the app's pattern store:
// parsed in the parser worker, laid out in the layout worker and drawn in
// structure or symbol mode, with the app's model controls (ModelPanel.tsx).
// Each model has its own layout worker, so two can lay out side by side.

import { applyObjectTransforms, readObjectTransforms, type Dimension, type Stitch } from "@crochet-model/core";
import { useEffect, useRef, useState } from "react";
import { ModelView, type ColorMode, type ViewMode } from "../view/modelView.ts";
import { LayoutCancelled, LayoutClient, ParserClient } from "../workers/clients.ts";

const QUALITY = { draft: 150, normal: 500, fine: 1500 } as const;
type Quality = keyof typeof QUALITY;

let sharedParser: ParserClient | undefined;
const parser = () => (sharedParser ??= new ParserClient());

/** Flat when most lines turn, as rows worked back and forth do; else 3D. */
export function guessCpDimension(cp: string): Dimension {
  const lines = cp.split("\n").filter((l) => l.trim());
  const turned = lines.filter((l) => /\bturn\b/.test(l)).length;
  return lines.length && turned * 2 >= lines.length ? 2 : 3;
}

/**
 * A step item's earlier steps as one piece of code, blank ones left out, as
 * the scorer joins them (packages/eval/src/score.ts).
 */
export const earlierCp = (context: { cp: string }[] | undefined) =>
  (context ?? []).map((c) => c.cp).filter((cp) => cp !== "").join("\n");

/**
 * `autoDimension` replaces the guess from `cp`, so models compared side by
 * side match. Pass `mode` and `onModeChange` to switch several models together.
 */
export function CpModel({
  cp,
  autoDimension,
  mode: sharedMode,
  onModeChange,
}: {
  cp: string;
  autoDimension?: Dimension;
  mode?: ViewMode;
  onModeChange?: (mode: ViewMode) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const cancel = useRef<() => void>(undefined);
  const layoutClient = useRef<LayoutClient>(undefined);
  const [override, setOverride] = useState<Dimension>();
  const [quality, setQuality] = useState<Quality>("normal");
  const [seed, setSeed] = useState<number | undefined>();
  const [ownMode, setOwnMode] = useState<ViewMode>();
  const [colors, setColors] = useState<Record<ViewMode, ColorMode>>({ structure: "type", symbols: "ink" });
  const [progress, setProgress] = useState<{ fraction: number; text: string }>();
  const [info, setInfo] = useState<string>();
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState<{ stitch: Stitch; x: number; y: number }>();

  const auto = autoDimension ?? guessCpDimension(cp);
  const dimension = override ?? auto;
  // As in the app: symbols for 2D, structure for 3D, unless chosen.
  const mode: ViewMode = sharedMode ?? ownMode ?? (dimension === 2 ? "symbols" : "structure");
  const colorMode = colors[mode];
  const chooseMode = onModeChange ?? setOwnMode;

  useEffect(() => {
    const v = new ModelView(host.current!);
    view.current = v;
    v.onHover = (h) => setHover(h ? { stitch: h.stitch, x: h.x, y: h.y } : undefined);
    const client = new LayoutClient();
    layoutClient.current = client;
    return () => {
      v.dispose();
      client.dispose();
    };
  }, []);

  useEffect(() => view.current?.setOptions({ mode, colorMode }), [mode, colorMode]);

  useEffect(() => {
    let stopped = false;
    let job: ReturnType<LayoutClient["layout"]> | undefined;
    setError(undefined);
    setInfo(undefined);
    setProgress({ fraction: 0, text: "parsing" });
    void parser()
      .validate(cp, { dimension, withGraph: true })
      .then(({ result, graph }) => {
        if (stopped) return;
        if (!result.ok || !graph) {
          setProgress(undefined);
          setError(result.error?.message ?? "The parser rejects this code.");
          return;
        }
        let retryNote = "";
        job = layoutClient.current!.layout(
          result.simpleDot!,
          { seed, iterations: QUALITY[quality] },
          (p) => setProgress({ fraction: p.iteration / p.iterations, text: `${retryNote}iteration ${p.iteration} of ${p.iterations}` }),
          (_seed, previous) => (retryNote = `seed ${previous.seedsTried.at(-1)} folded, retrying · `),
          seed === undefined ? undefined : 1,
        );
        cancel.current = job.cancel;
        return job.promise.then((layout) => {
          if (stopped) return;
          view.current!.setModel(graph, { ...layout, positions: applyObjectTransforms(graph, layout.positions, readObjectTransforms(cp)) });
          setInfo(`${graph.stitches.length} stitches · ${dimension}D · seed ${layout.seed} · ${(layout.ms / 1000).toFixed(1)} s`);
          setProgress(undefined);
        });
      })
      .catch((e: unknown) => {
        if (stopped) return;
        setProgress(undefined);
        setInfo(e instanceof LayoutCancelled ? "Layout stopped." : `Layout failed: ${(e as Error).message}`);
      });
    return () => {
      stopped = true;
      job?.cancel();
    };
  }, [cp, dimension, seed, quality]);

  const box = host.current?.getBoundingClientRect();
  return (
    <div className="cp-model">
      <div className="model-controls">
        <select aria-label="View" value={mode} onChange={(e) => chooseMode(e.target.value as ViewMode)}>
          <option value="structure">Structure</option>
          <option value="symbols">Symbols</option>
        </select>
        <select aria-label="Dimension" value={override ?? "auto"} onChange={(e) => setOverride(e.target.value === "auto" ? undefined : (Number(e.target.value) as Dimension))}>
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
          <option value="type">By stitch</option>
          <option value="yarn">Yarn colour</option>
        </select>
        <button className="button small" title="Lay out again from another seed: try this when a 3D piece comes out inside-out" onClick={() => setSeed((s) => (s ?? 0) + 1)} disabled={!!error}>
          Flip inside-out
        </button>
        <button className="button small" onClick={() => view.current?.fit()}>
          Fit
        </button>
      </div>
      <div className="viewport" ref={host}>
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
            <strong>The code does not parse.</strong>
            <span>{error}</span>
          </div>
        )}
        {hover && box && (
          <div className="tooltip" style={{ left: hover.x - box.left + 12, top: hover.y - box.top + 12 }}>
            <b>{hover.stitch.type}</b> · row {hover.stitch.row}, stitch {hover.stitch.index + 1}
          </div>
        )}
      </div>
      <p className="hint model-foot">{info ?? ""}</p>
    </div>
  );
}
