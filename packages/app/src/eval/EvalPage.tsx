// Eval results for people: pick one run, or several of the same dataset to
// combine, read the scores, then go through the items: English, gold and
// output side by side, and each row's attempts with the parser's verdict.

import { useEffect, useMemo, useState } from "react";
import type { RunInfo, View, ViewItem } from "../../../eval/src/viewer.ts";
import type { ItemScore } from "../../../eval/src/score.ts";
import type { Summary } from "../../../eval/src/summary.ts";
import { CpModel, earlierCp, guessCpDimension } from "../datasets/CpModel.tsx";
import type { ViewMode } from "../view/modelView.ts";
import { YarnMark } from "../ui/App.tsx";

export type Status = "exact" | "partial" | "parses" | "no-parse" | "empty" | "incomplete" | "skipped";

export const STATUSES: { id: Status; label: string; tone: string; help: string }[] = [
  { id: "exact", label: "Exact", tone: "ok", help: "Same stitches, worked into the same places, as the gold" },
  { id: "partial", label: "Partial", tone: "warn", help: "Parses, but the structure differs from the gold" },
  { id: "parses", label: "Parses", tone: "ok", help: "Parses; no gold to compare with" },
  { id: "no-parse", label: "Doesn't parse", tone: "bad", help: "The parser rejects the output" },
  { id: "empty", label: "Empty", tone: "bad", help: "No CrochetPARADE came back" },
  { id: "incomplete", label: "Request failed", tone: "faint", help: "A request failed (a rate limit, say); left out of the scores" },
  { id: "skipped", label: "Gold broken", tone: "faint", help: "The gold does not parse, so the item is not scored" },
];
export const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s])) as Record<Status, (typeof STATUSES)[number]>;

function statusOf(item: ViewItem, output: string): Status {
  return scoreStatus(item.gold?.ok, item.incomplete, item.scores[output]);
}

export function scoreStatus(goldOk: boolean | undefined, incomplete: boolean, s: ItemScore | undefined): Status {
  if (goldOk === false) return "skipped";
  if (incomplete) return "incomplete";
  if (!s?.nonEmpty) return "empty";
  if (!s.parses) return "no-parse";
  if (s.structure) return s.structure.exact ? "exact" : "partial";
  return "parses";
}

const pct = (x: number | undefined) => (x === undefined ? "–" : `${(100 * x).toFixed(1)}%`);
export const when = (name: string) => name.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*/, "$1-$2-$3 $4:$5");
const modelOf = (r: RunInfo) => (r.llm ? `${r.llm.model} · ${r.llm.effort}` : r.translator);

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

// --- URL hash: #runs=a,b&item=ss-012 ------------------------------------------

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  return { runs: q.get("runs")?.split(",").filter(Boolean) ?? [], item: q.get("item") ?? undefined };
}

function writeHash(runs: string[], item: string | undefined) {
  const q = new URLSearchParams();
  if (runs.length) q.set("runs", runs.join(","));
  if (item) q.set("item", item);
  history.replaceState(null, "", `#${q.toString().replace(/%2C/g, ",")}`);
}

// --- Page ---------------------------------------------------------------------

export function EvalPage() {
  const [runs, setRuns] = useState<RunInfo[]>();
  const [chosen, setChosen] = useState<string[]>(() => readHash().runs);
  const [view, setView] = useState<View>();
  const [error, setError] = useState<string>();
  const [itemId, setItemId] = useState<string | undefined>(() => readHash().item);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [query, setQuery] = useState("");
  const [hideSuspect, setHideSuspect] = useState(false);

  useEffect(() => {
    getJson<RunInfo[]>("/__eval/runs")
      .then((list) => {
        setRuns(list);
        setChosen((c) => (c.length ? c : list.length ? [list[0]!.name] : []));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!chosen.length) return;
    setError(undefined);
    getJson<View>(`/__eval/view?runs=${encodeURIComponent(chosen.join(","))}`)
      .then(setView)
      .catch((e: Error) => {
        setView(undefined);
        setError(e.message);
      });
  }, [chosen]);

  useEffect(() => writeHash(chosen, itemId), [chosen, itemId]);

  const suspects = useMemo(() => new Map((view?.suspects ?? []).filter((s) => s.status !== "rejected").map((s) => [s.id, s])), [view]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUSES.map((s) => [s.id, 0])) as Record<Status, number>;
    for (const i of view?.items ?? []) c[statusOf(i, view!.output)]++;
    return c;
  }, [view]);
  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.items.filter(
      (i) =>
        (filter === "all" || statusOf(i, view.output) === filter) &&
        (!hideSuspect || !suspects.has(i.id)) &&
        (!q || `${i.id} ${i.name} ${i.item?.english ?? ""}`.toLowerCase().includes(q)),
    );
  }, [view, filter, query, hideSuspect, suspects]);
  const item = view?.items.find((i) => i.id === itemId);

  const toggle = (run: RunInfo) => {
    const first = runs?.find((r) => r.name === chosen[0]);
    if (chosen.includes(run.name)) setChosen(chosen.length > 1 ? chosen.filter((n) => n !== run.name) : chosen);
    else if (first && first.dataset === run.dataset) setChosen([...chosen, run.name]);
    else setChosen([run.name]);
  };
  const sameConfig = () => {
    const first = runs?.find((r) => r.name === chosen[0]);
    if (!first || !runs) return;
    setChosen(
      runs
        .filter((r) => r.dataset === first.dataset && r.promptVersion === first.promptVersion && r.outputs[0] === first.outputs[0])
        .map((r) => r.name),
    );
  };

  return (
    <div className="shell eval-page">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Crochet Model, home">
          <YarnMark />
          <span>
            Crochet <em>Model</em>
          </span>
        </a>
        <p className="tagline">Evaluation results</p>
        <nav className="account">
          <a href="/datasets.html">Datasets</a>
          <a href="/">Back to the app</a>
        </nav>
      </header>

      <main className="eval-main">
        {error && <p className="callout bad">{error}</p>}

        <RunPicker runs={runs} chosen={chosen} onPick={(r) => setChosen([r.name])} onToggle={toggle} onSameConfig={sameConfig} />

        {view && (
          <>
            <Scores view={view} />

            <section className="eval-section">
              <div className="status-bar" role="img" aria-label="Items by status">
                {STATUSES.filter((s) => counts[s.id]).map((s) => (
                  <span key={s.id} className={`seg ${s.tone}`} style={{ flexGrow: counts[s.id] }} title={`${s.label}: ${counts[s.id]}`} />
                ))}
              </div>
              <div className="filters">
                <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
                  All <b>{view.items.length}</b>
                </button>
                {STATUSES.filter((s) => counts[s.id]).map((s) => (
                  <button key={s.id} className={`chip ${s.tone} ${filter === s.id ? "on" : ""}`} title={s.help} onClick={() => setFilter(s.id)}>
                    <i className="dot" /> {s.label} <b>{counts[s.id]}</b>
                  </button>
                ))}
                <label className="check-inline">
                  <input type="checkbox" checked={hideSuspect} onChange={(e) => setHideSuspect(e.target.checked)} /> Hide suspect gold
                </label>
                <input className="search" type="search" placeholder="Search id, name or English" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </section>

            <div className="eval-split">
              <ItemList items={shown} output={view.output} suspects={suspects} selected={itemId} onSelect={setItemId} />
              <div className="detail-wrap">
                {item ? (
                  <ItemDetail key={item.id} item={item} output={view.output} suspect={suspects.get(item.id)} />
                ) : (
                  <p className="hint detail-empty">Choose an item to see its English, the gold and the translation.</p>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// --- Runs ---------------------------------------------------------------------

function RunPicker(props: {
  runs: RunInfo[] | undefined;
  chosen: string[];
  onPick: (r: RunInfo) => void;
  onToggle: (r: RunInfo) => void;
  onSameConfig: () => void;
}) {
  const { runs, chosen } = props;
  if (!runs) return <p className="hint">Loading runs…</p>;
  if (!runs.length)
    return (
      <p className="callout warn">
        No runs in <code>packages/eval/runs/</code> yet. Start one with <code>npm run eval -- run …</code>.
      </p>
    );
  return (
    <section className="eval-section">
      <div className="section-head">
        <h2>Runs</h2>
        <p className="hint">Click a run to read it. Tick more runs of the same dataset to combine them: each item comes from the latest run where it completed.</p>
        <button className="button small" onClick={props.onSameConfig} title="Every run with the same dataset, model and prompt version">
          Combine all with this setup
        </button>
      </div>
      <div className="table-scroll runs-scroll">
        <table className="runs">
          <thead>
            <tr>
              <th aria-label="Combine" />
              <th>Started</th>
              <th>Dataset</th>
              <th>Translator</th>
              <th>Prompt</th>
              <th className="num">Items</th>
              <th className="num">Parses</th>
              <th className="num">Exact</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const s = r.summaries.find((x) => !x.excludedSuspect);
              const on = chosen.includes(r.name);
              return (
                <tr key={r.name} className={on ? "on" : ""} onClick={() => props.onPick(r)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={on} onChange={() => props.onToggle(r)} aria-label={`Combine ${r.name}`} />
                  </td>
                  <td title={r.name}>{when(r.name)}</td>
                  <td>{r.dataset}</td>
                  <td className="mono">{modelOf(r)}</td>
                  <td className="mono faint">{r.promptVersion?.slice(0, 7) ?? "–"}</td>
                  <td className="num">{r.items}</td>
                  <td className="num">{s ? pct(s.parses / s.scored) : "–"}</td>
                  <td className="num">{pct(s?.structureExact)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">The run table's numbers are as the run wrote them, failed requests included. The scores below leave those items out.</p>
    </section>
  );
}

// --- Scores -------------------------------------------------------------------

function Scores({ view }: { view: View }) {
  const [all, clean] = view.summaries;
  const cols: { label: string; help: string; value: (s: Summary) => string }[] = [
    { label: "Items", help: "Complete items scored", value: (s) => String(s.scored) },
    { label: "Parses", help: "The parser accepts the output", value: (s) => pct(s.parses / s.scored) },
    { label: "Exact", help: "Structure identical to the gold", value: (s) => pct(s.structureExact) },
    { label: "Partial", help: "Mean share of stitches matching the gold", value: (s) => pct(s.structureScore) },
    { label: "Counts", help: "Rows whose stitch count matches the English", value: (s) => (s.countItems ? pct(s.countMatch) : "–") },
    { label: "chrF", help: "Character overlap with the gold text", value: (s) => (s.chrF === undefined ? "–" : s.chrF.toFixed(1)) },
    { label: "Rows kept", help: "English rows with a translation in the output", value: (s) => pct(s.rowsKept) },
    { label: "Req/item", help: "Model requests per item, repairs included", value: (s) => (s.requestsPerItem === undefined ? "–" : s.requestsPerItem.toFixed(1)) },
    { label: "Cost", help: "US$", value: (s) => (s.costUsd === undefined ? "–" : `$${s.costUsd.toFixed(2)}`) },
  ];
  const r = view.runs[0]!;
  return (
    <section className="eval-section">
      <div className="section-head">
        <h2>
          {view.dataset} <span className="faint">·</span> <span className="mono small">{r.llm ? String(r.llm.model) : r.translator}</span>
        </h2>
        <p className="hint">
          {view.runs.length > 1 ? `${view.runs.length} runs combined. ` : ""}
          {view.incomplete.length > 0 && (
            <span className="warn-text">
              {view.incomplete.length} of {view.items.length} items have a failed request and are left out.
            </span>
          )}
        </p>
      </div>
      {all ? (
        <div className="table-scroll">
          <table className="scores">
            <thead>
              <tr>
                <th />
                {cols.map((c) => (
                  <th key={c.label} title={c.help} className="num">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[all, clean].filter((s): s is Summary => !!s).map((s, i) => (
                <tr key={i}>
                  <th scope="row">{i === 0 ? "All complete items" : `Without ${s.excludedSuspect!.length} suspect gold`}</th>
                  {cols.map((c) => (
                    <td key={c.label} className="num">
                      {c.value(s)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="callout warn">No complete items to score.</p>
      )}
    </section>
  );
}

// --- Models -------------------------------------------------------------------

/**
 * The output's model beside the gold's. A step item's output is drawn after
 * its earlier steps, as the scorer parses it, beside the earlier steps alone.
 */
function Models({ item, output }: { item: ViewItem; output: string }) {
  const [mode, setMode] = useState<ViewMode>();
  const gold = item.item?.gold;
  const earlier = earlierCp(item.item?.context);
  const code = codeLines(output).length ? output : "";
  const reference = gold?.trim() ? { label: "Gold", cp: gold } : earlier ? { label: "Earlier steps", cp: earlier } : undefined;
  const result = code ? { label: earlier ? "Earlier steps + output" : "Output", cp: earlier ? `${earlier}\n${code}` : code } : undefined;
  if (!reference && !result) return null;
  const dimension = guessCpDimension(reference?.cp ?? result!.cp);
  const models = [reference, result].filter((m): m is { label: string; cp: string } => !!m);
  // Gold and output switch view mode together.
  return (
    <section className="models">
      <h3 className="eyebrow">Models</h3>
      <div className={`compare ${models.length === 2 ? "two-even" : "one"}`}>
        {models.map((m) => (
          <div key={m.label}>
            <h4 className="model-label">{m.label}</h4>
            <CpModel cp={m.cp} autoDimension={dimension} mode={mode} onModeChange={setMode} />
          </div>
        ))}
      </div>
      {!result && <p className="hint">No output to draw.</p>}
    </section>
  );
}

// --- Items --------------------------------------------------------------------

function ItemList(props: {
  items: ViewItem[];
  output: string;
  suspects: Map<string, unknown>;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="item-list" role="listbox" aria-label="Items">
      {props.items.length === 0 && <p className="hint">No items match.</p>}
      {props.items.map((i) => {
        const st = STATUS[statusOf(i, props.output)];
        const sc = i.scores[props.output];
        return (
          <button
            key={i.id}
            role="option"
            aria-selected={props.selected === i.id}
            className={`item-row ${props.selected === i.id ? "on" : ""}`}
            onClick={() => props.onSelect(i.id)}
          >
            <span className="item-id mono">{i.id}</span>
            <span className="item-name">{i.name}</span>
            <span className={`pill ${st.tone}`}>{st.label}</span>
            <span className="item-meta">
              {sc?.structure && st.id !== "incomplete" && <Meter value={sc.structure.score} />}
              {props.suspects.has(i.id) && (
                <span className="flag" title="Suspect gold: see gold-suspect.json">
                  gold?
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The dataset's photo of the finished project, loaded from the publisher's
 * site (never copied here). No referrer is sent; a link that fails is hidden.
 */
export function Photo({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <a className="photo" href={url} target="_blank" rel="noreferrer noopener" title="Open the full photo (publisher's site)">
      <img src={url} alt={`Finished project: ${name}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      <span>Finished project</span>
    </a>
  );
}

function Meter({ value }: { value: number }) {
  return (
    <span className="meter" title={`Structure ${value.toFixed(2)}`}>
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

const norm = (line: string) => line.replace(/#.*/, "").replace(/\s+/g, "");
const codeLines = (cp: string) => cp.split("\n").filter((l) => norm(l));

function ItemDetail({ item, output, suspect }: { item: ViewItem; output: string; suspect?: View["suspects"][number] }) {
  const st = STATUS[statusOf(item, output)];
  const score = item.scores[output];
  const out = item.outputs[output] ?? "";
  const gold = item.item?.gold;
  const goldLines = gold ? codeLines(gold) : [];
  const outLines = codeLines(out);
  const rows = new Map((item.llm?.input.rows ?? []).map((r) => [r.id, r]));
  const diff = score?.structure?.firstDifference;

  return (
    <article className="detail">
      <header className={`detail-head ${item.imageUrl ? "with-photo" : ""}`}>
        {item.imageUrl && <Photo url={item.imageUrl} name={item.name} />}
        <h2>
          <span className="mono">{item.id}</span> {item.name}
        </h2>
        <div className="row-actions">
          <span className={`pill ${st.tone}`} title={st.help}>
            {st.label}
          </span>
          {score?.structure && (
            <span className="stat-inline">
              structure <b>{score.structure.score.toFixed(2)}</b> ({score.structure.matched}/{Math.max(score.structure.goldStitches, score.structure.outputStitches)} stitches)
            </span>
          )}
          {score?.counts && score.counts.checked > 0 && (
            <span className="stat-inline">
              counts <b>{score.counts.matched}/{score.counts.checked}</b>
            </span>
          )}
          {item.llm && (
            <span className="stat-inline">
              requests <b>{item.llm.requests}</b>
            </span>
          )}
          <span className="stat-inline">
            <b>{(item.ms / 1000).toFixed(1)}</b> s
          </span>
        </div>
        <p className="hint mono">from {item.run}</p>
      </header>

      {suspect && (
        <div className="callout warn">
          <p>
            <b>Suspect gold</b> ({suspect.status}, rows {suspect.rows.join(", ")}): {suspect.issue}
          </p>
          <p className="hint">{suspect.evidence}</p>
        </div>
      )}
      {item.incomplete && <p className="callout warn">A request failed for at least one row, so this result is incomplete. Run the item again.</p>}
      {item.gold?.ok === false && <p className="callout warn">The gold does not parse: {item.gold.error}</p>}
      {score?.error && (
        <p className="callout bad">
          Parser: {score.error.message}
        </p>
      )}
      {diff && (
        <p className="first-diff">
          First difference at parser row {diff.row}, stitch {diff.index}: gold <code>{diff.gold ?? "none"}</code>, output <code>{diff.output ?? "none"}</code>
        </p>
      )}

      {item.item?.context && item.item.context.length > 0 && (
        <details className="context">
          <summary>Earlier steps given as context ({item.item.context.length})</summary>
          {item.item.context.map((c, i) => (
            <div key={i} className="compare two">
              <pre className="english">{c.english}</pre>
              <pre className="code">{c.cp}</pre>
            </div>
          ))}
        </details>
      )}

      <div className={`compare ${gold === undefined ? "two" : "three"}`}>
        <div>
          <h3 className="eyebrow">English</h3>
          <pre className="english">{item.item?.english ?? (item.llm?.input.english || "–")}</pre>
        </div>
        {gold !== undefined && (
          <div>
            <h3 className="eyebrow">Gold</h3>
            <pre className="code">
              {goldLines.map((l, i) => (
                <span key={i} className="line">
                  {l}
                </span>
              ))}
            </pre>
          </div>
        )}
        <div>
          <h3 className="eyebrow">Output</h3>
          <pre className="code">
            {outLines.length === 0 && <span className="faint">(empty)</span>}
            {outLines.map((l, i) => (
              <span key={i} className={`line ${gold !== undefined && norm(l) !== norm(goldLines[i] ?? "") ? "differs" : ""}`}>
                {l}
              </span>
            ))}
          </pre>
        </div>
      </div>
      {gold !== undefined && <p className="hint">Highlighted output lines differ from the gold line in the same place (spaces ignored). Different text can still be the same structure.</p>}

      <Models item={item} output={out} />

      {item.llm && item.llm.translations.length > 0 && (
        <section className="rows">
          <h3 className="eyebrow">Rows, as the translator saw them</h3>
          {item.llm.translations.map((t) => {
            const row = rows.get(t.rowId);
            return (
              <div key={t.rowId} className={`row-card ${t.status}`}>
                <div className="row-top">
                  <span className="row-label">{row?.label || "·"}</span>
                  <span className="row-text">{row?.text ?? t.rowId}</span>
                  <span className={`pill ${t.status === "valid" ? "ok" : t.status === "invalid" ? "bad" : "warn"}`}>{t.status}</span>
                  <span className="faint small">{t.confidence}</span>
                </div>
                <pre className="code">{t.cp || <span className="faint">(empty)</span>}</pre>
                {t.assumptions.length > 0 && (
                  <ul className="assumptions">
                    {t.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
                {t.question && <p className="hint">Asked: {t.question.text}</p>}
                {t.attempts.length > 0 && (
                  <details open={t.attempts.length > 1 || t.status !== "valid"}>
                    <summary>
                      {t.attempts.length} attempt{t.attempts.length === 1 ? "" : "s"}
                    </summary>
                    <ol className="attempts">
                      {t.attempts.map((a, i) => (
                        <li key={i}>
                          <pre className="code">{a.cp || <span className="faint">(empty)</span>}</pre>
                          <p className={a.validation.ok && !a.rejected ? "ok-text" : "bad-text"}>
                            {a.rejected
                              ? `Rejected: ${a.rejected}${a.validation.error ? `: ${a.validation.error.message}` : ""}`
                              : a.validation.ok
                                ? `Parses${a.validation.rows.length ? `; last line counts ${a.validation.rows.at(-1)!.stitches}` : ""}`
                                : `Parser: ${a.validation.error?.message ?? "rejected"}`}
                          </p>
                          <p className="faint small">
                            {a.model} · {a.usage.inputTokens + a.usage.cacheReadTokens} in, {a.usage.outputTokens} out
                          </p>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            );
          })}
        </section>
      )}
    </article>
  );
}
