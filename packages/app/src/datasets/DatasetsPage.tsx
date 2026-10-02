// The evaluation datasets for people: pick a dataset, go through its items
// (English, gold, earlier steps, the finished project's photo, suspect-gold
// notes) and see how each run did on an item, with a link into the eval page.

import { useEffect, useMemo, useState } from "react";
import type { DatasetInfo, DatasetItem, DatasetView, ItemRun } from "../../../eval/src/viewer.ts";
import { getJson, Photo, scoreStatus, STATUS, when } from "../eval/EvalPage.tsx";
import { YarnMark } from "../ui/App.tsx";
import { CpModel, earlierCp } from "./CpModel.tsx";

type Filter = "all" | "gold" | "context" | "photo" | "suspect" | "unrun" | "failing";

const FILTERS: { id: Filter; label: string; help: string; test: (i: DatasetItem) => boolean }[] = [
  { id: "gold", label: "Gold", help: "Has gold CrochetPARADE for the whole item", test: (i) => i.gold !== undefined },
  { id: "context", label: "Earlier steps", help: "Comes with earlier steps and their CrochetPARADE", test: (i) => !!i.context?.length },
  { id: "photo", label: "Photo", help: "Has a photo of the finished project", test: (i) => !!i.imageUrl },
  { id: "suspect", label: "Suspect gold", help: "Listed in gold-suspect.json", test: (i) => !!i.suspect },
  { id: "unrun", label: "Never run", help: "No run has translated this item", test: (i) => i.runs.length === 0 },
  { id: "failing", label: "Latest fails", help: "The latest complete run's output is empty or does not parse", test: (i) => isFailing(latest(i)) },
];

/** The newest run with no failed request for the item. */
const latest = (i: DatasetItem) => i.runs.find((r) => !r.incomplete);
const statusOfRun = (r: ItemRun) => STATUS[scoreStatus(r.goldOk, r.incomplete, r.score)];
const isFailing = (r: ItemRun | undefined) => !!r && ["empty", "no-parse"].includes(statusOfRun(r).id);
const lineCount = (text: string) => text.split("\n").filter((l) => l.trim()).length;
const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

// --- URL hash: #dataset=stitchswitch&item=ss-012 ------------------------------

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  return { dataset: q.get("dataset") ?? undefined, item: q.get("item") ?? undefined };
}

function writeHash(dataset: string | undefined, item: string | undefined) {
  const q = new URLSearchParams();
  if (dataset) q.set("dataset", dataset);
  if (item) q.set("item", item);
  history.replaceState(null, "", `#${q.toString()}`);
}

// --- Page ---------------------------------------------------------------------

export function DatasetsPage() {
  const [datasets, setDatasets] = useState<DatasetInfo[]>();
  const [chosen, setChosen] = useState<string | undefined>(() => readHash().dataset);
  const [view, setView] = useState<DatasetView>();
  const [error, setError] = useState<string>();
  const [itemId, setItemId] = useState<string | undefined>(() => readHash().item);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    getJson<DatasetInfo[]>("/__eval/datasets")
      .then((list) => {
        setDatasets(list);
        setChosen((c) => c ?? list.find((d) => d.items !== undefined)?.name);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!chosen) return;
    setError(undefined);
    setView(undefined);
    getJson<DatasetView>(`/__eval/dataset?name=${encodeURIComponent(chosen)}`)
      .then(setView)
      .catch((e: Error) => setError(e.message));
  }, [chosen]);

  useEffect(() => writeHash(chosen, itemId), [chosen, itemId]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, view?.items.filter(f.test).length ?? 0])) as Record<Filter, number>,
    [view],
  );
  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
    return view.items.filter((i) => test(i) && (!q || `${i.id} ${i.name} ${i.english}`.toLowerCase().includes(q)));
  }, [view, filter, query]);
  const item = view?.items.find((i) => i.id === itemId);

  const pick = (name: string) => {
    if (name === chosen) return;
    setChosen(name);
    setItemId(undefined);
    setFilter("all");
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
        <p className="tagline">Evaluation datasets</p>
        <nav className="account">
          <a href="/eval.html">Eval results</a>
          <a href="/">Back to the app</a>
        </nav>
      </header>

      <main className="eval-main">
        {error && <p className="callout bad">{error}</p>}

        <DatasetPicker datasets={datasets} chosen={chosen} onPick={pick} />

        {view && (
          <>
            <section className="eval-section">
              <div className="section-head">
                <h2>{view.info.title}</h2>
                <p className="hint">
                  {view.info.about}{" "}
                  <a href={view.info.paper} target="_blank" rel="noreferrer noopener">
                    Paper
                  </a>
                </p>
              </div>
              <div className="filters">
                <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
                  All <b>{view.items.length}</b>
                </button>
                {FILTERS.filter((f) => counts[f.id]).map((f) => (
                  <button key={f.id} className={`chip ${filter === f.id ? "on" : ""}`} title={f.help} onClick={() => setFilter(f.id)}>
                    {f.label} <b>{counts[f.id]}</b>
                  </button>
                ))}
                <input className="search" type="search" placeholder="Search id, name or English" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </section>

            <div className="eval-split">
              <ItemList items={shown} selected={itemId} onSelect={setItemId} />
              <div className="detail-wrap">
                {item ? (
                  <ItemDetail key={item.id} item={item} />
                ) : (
                  <p className="hint detail-empty">Choose an item to see its English, the gold and how each run did on it.</p>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// --- Datasets -----------------------------------------------------------------

function DatasetPicker(props: { datasets: DatasetInfo[] | undefined; chosen: string | undefined; onPick: (name: string) => void }) {
  const { datasets, chosen } = props;
  if (!datasets) return <p className="hint">Loading datasets…</p>;
  return (
    <section className="eval-section">
      <div className="section-head">
        <h2>Datasets</h2>
        <p className="hint">
          Downloaded into <code>packages/eval/data/</code> by <code>npm run eval -- fetch</code>, pinned to the commits below. For local evaluation only: never commit them or use them as prompt examples.
        </p>
      </div>
      <div className="table-scroll">
        <table className="runs datasets">
          <thead>
            <tr>
              <th>Dataset</th>
              <th>Source</th>
              <th className="num">Items</th>
              <th className="num" title="Items with gold CrochetPARADE for the whole item">Gold</th>
              <th className="num" title="Items given earlier steps as context">Steps</th>
              <th className="num" title="Items with a photo of the finished project">Photos</th>
              <th className="num" title="Suspected or confirmed in gold-suspect.json">Suspect</th>
              <th className="num">Runs</th>
              <th>Licence</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.name} className={`${d.name === chosen ? "on" : ""} ${d.error ? "missing" : ""}`} onClick={() => !d.error && props.onPick(d.name)}>
                <td>
                  <b>{d.title}</b> <span className="mono faint">{d.name}</span>
                </td>
                <td className="mono">
                  <a href={`https://github.com/${d.repo}/tree/${d.commit}`} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                    {d.repo}@{d.commit.slice(0, 7)}
                  </a>
                </td>
                {d.error ? (
                  <td colSpan={6} className="warn-text">
                    {d.error}
                  </td>
                ) : (
                  <>
                    <td className="num">{d.items}</td>
                    <td className="num">{d.withGold || "–"}</td>
                    <td className="num">{d.withContext || "–"}</td>
                    <td className="num">{d.withPhoto || "–"}</td>
                    <td className="num">{d.suspects || "–"}</td>
                    <td className="num">{d.runs || "–"}</td>
                  </>
                )}
                <td className="faint">{d.licence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Items --------------------------------------------------------------------

function ItemList(props: { items: DatasetItem[]; selected: string | undefined; onSelect: (id: string) => void }) {
  return (
    <div className="item-list" role="listbox" aria-label="Items">
      {props.items.length === 0 && <p className="hint">No items match.</p>}
      {props.items.map((i) => {
        const last = latest(i);
        const st = last && statusOfRun(last);
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
            {st ? (
              <span className={`pill ${st.tone}`} title={`Latest complete run: ${st.help}`}>
                {st.label}
              </span>
            ) : (
              <span className="pill faint" title="No complete run of this item">
                {i.runs.length ? "Request failed" : "Not run"}
              </span>
            )}
            <span className="item-meta tags">
              <span>{lines(lineCount(i.english))}</span>
              {i.gold !== undefined && <span>gold</span>}
              {!!i.context?.length && <span>{i.context.length} earlier</span>}
              {i.imageUrl && <span>photo</span>}
              {i.suspect && (
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

/** The item's own CrochetPARADE: the gold, else the earlier steps' code. */
function modelSource(item: DatasetItem): { cp: string; label: string } | undefined {
  if (item.gold?.trim()) return { cp: item.gold, label: "Model of the gold" };
  const earlier = earlierCp(item.context);
  if (earlier) return { cp: earlier, label: "Model of the earlier steps" };
  return undefined;
}

function ItemDetail({ item }: { item: DatasetItem }) {
  const { suspect } = item;
  const model = modelSource(item);
  return (
    <article className="detail">
      <header className={`detail-head ${item.imageUrl ? "with-photo" : ""}`}>
        {item.imageUrl && <Photo url={item.imageUrl} name={item.name} />}
        <h2>
          <span className="mono">{item.id}</span> {item.name}
        </h2>
        <div className="row-actions">
          <span className="stat-inline">
            {lines(lineCount(item.english))} of English
          </span>
          {item.gold !== undefined && (
            <span className="stat-inline">
              {lines(lineCount(item.gold))} of gold
            </span>
          )}
          {item.statedCount !== undefined && (
            <span className="stat-inline" title="The stitch count the English states">
              stated count <b>{item.statedCount}</b>
            </span>
          )}
          {item.variation && (
            <span className="stat-inline" title="StitchSwitch Variation column, as written">
              variation <b>{item.variation}</b>
            </span>
          )}
        </div>
      </header>

      {suspect && (
        <div className="callout warn">
          <p>
            <b>Suspect gold</b> ({suspect.status}, rows {suspect.rows.join(", ")}): {suspect.issue}
          </p>
          <p className="hint">{suspect.evidence}</p>
        </div>
      )}

      {item.context && item.context.length > 0 && (
        <details className="context" open={item.context.length <= 3}>
          <summary>Earlier steps given as context ({item.context.length})</summary>
          {item.context.map((c, i) => (
            <div key={i} className="compare two">
              <pre className="english">{c.english}</pre>
              <pre className="code">{c.cp}</pre>
            </div>
          ))}
        </details>
      )}

      <div className={`compare ${item.gold === undefined ? "one" : "two"}`}>
        <div>
          <h3 className="eyebrow">{item.context?.length ? "English to translate" : "English"}</h3>
          <pre className="english">{item.english}</pre>
        </div>
        {item.gold !== undefined && (
          <div>
            <h3 className="eyebrow">Gold</h3>
            <pre className="code">{item.gold}</pre>
          </div>
        )}
      </div>

      {model && (
        <section className="eval-section">
          <h3 className="eyebrow">{model.label}</h3>
          <CpModel cp={model.cp} />
        </section>
      )}

      <section className="eval-section">
        <h3 className="eyebrow">Runs</h3>
        {item.runs.length === 0 ? (
          <p className="hint">
            No run has translated this item yet. Start one with <code>npm run eval -- run --dataset …</code>.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="runs">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Translator</th>
                  <th>Result</th>
                  <th className="num">Structure</th>
                  <th className="num">Counts</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {item.runs.map((r) => {
                  const st = statusOfRun(r);
                  const href = `/eval.html#runs=${encodeURIComponent(r.run)}&item=${encodeURIComponent(item.id)}`;
                  return (
                    <tr key={r.run} onClick={() => (location.href = href)}>
                      <td title={r.run}>{when(r.run)}</td>
                      <td className="mono">{r.translator}</td>
                      <td>
                        <span className={`pill ${st.tone}`} title={st.help}>
                          {st.label}
                        </span>
                      </td>
                      <td className="num">{r.score?.structure ? r.score.structure.score.toFixed(2) : "–"}</td>
                      <td className="num">{r.score?.counts?.checked ? `${r.score.counts.matched}/${r.score.counts.checked}` : "–"}</td>
                      <td>
                        <a href={href}>Open in eval</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}
