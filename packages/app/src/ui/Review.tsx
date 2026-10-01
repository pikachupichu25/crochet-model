// The Review screen (FR-3.1 to FR-3.5): English, CrochetPARADE and status side
// by side; questions to answer; assumptions to dismiss or reject; each row's
// code editable, with parser errors inline. Clicking a row highlights its
// stitches in the model, and a clicked stitch selects its row (FR-3.2).

import type { PatternRow, RowTranslation } from "@crochet-model/core";
import { Fragment, useEffect, useRef, useState } from "react";
import { PROVIDER_NAMES } from "../api.ts";
import { checkRow, useCheck } from "../check.ts";
import { exportText, rowLabel, summarise } from "../pattern.ts";
import {
  answerQuestion,
  cancelTranslation,
  dismissAssumption,
  editRow,
  hasKey,
  rejectAssumption,
  retranslateRow,
  selectRow,
  useApp,
} from "../store.ts";
import { CodeEditor } from "./CodeEditor.tsx";

export function Review({ onEditPattern }: { onEditPattern: () => void }) {
  const rows = useApp((s) => s.segmented.rows);
  const notes = useApp((s) => s.segmented.notes);
  const translations = useApp((s) => s.translations);
  const translating = useApp((s) => s.translating);
  const busyRows = useApp((s) => s.busyRows);
  const lastRun = useApp((s) => s.lastRun);
  const error = useApp((s) => s.error);
  const sampleId = useApp((s) => s.sampleId);
  const colors = useApp((s) => s.colors);
  const [view, setView] = useState<"rows" | "code">("rows");
  const summary = summarise(rows, translations);
  const done = rows.length - Object.keys(busyRows).length;

  if (rows.length === 0) {
    return (
      <div className="pane empty">
        <p>No rows yet.</p>
        <button className="button" onClick={onEditPattern}>
          Paste a pattern
        </button>
      </div>
    );
  }

  return (
    <div className="pane review-pane">
      <div className="summary" aria-live="polite">
        {translating ? (
          <>
            <div className="progress" style={{ ["--done" as string]: `${(done / rows.length) * 100}%` }} />
            <span>
              Translating row {Math.min(done + 1, rows.length)} of {rows.length}…
            </span>
            <button className="link" onClick={cancelTranslation}>
              Stop
            </button>
          </>
        ) : (
          <>
            <Stat n={summary.translated} of={summary.rows} label="translated" />
            {summary.questions > 0 && <Stat n={summary.questions} label={summary.questions === 1 ? "question" : "questions"} tone="ask" />}
            {summary.mismatched > 0 && <Stat n={summary.mismatched} label="count off" tone="warn" />}
            {summary.failed > 0 && <Stat n={summary.failed} label="failed, left out of the model" tone="bad" />}
            {summary.edited > 0 && <Stat n={summary.edited} label="edited by you" />}
            {sampleId && <span className="pill">sample translation</span>}
            {lastRun && (
              <span className="hint run">
                {PROVIDER_NAMES[lastRun.provider]} · {lastRun.model} · {lastRun.requests} requests
                {lastRun.costUsd != null ? ` · US$${lastRun.costUsd.toFixed(3)}` : ""}
              </span>
            )}
          </>
        )}
        <div className="view-switch" role="group" aria-label="View">
          <button aria-pressed={view === "rows"} onClick={() => setView("rows")}>
            Rows
          </button>
          <button aria-pressed={view === "code"} onClick={() => setView("code")}>
            Code
          </button>
        </div>
      </div>
      {error && (
        <p className="callout bad" role="alert">
          {error}
        </p>
      )}

      {view === "code" ? (
        <WholeCode text={exportText(rows, notes, translations, colors)} />
      ) : (
        <div className="rows" role="table" aria-label="Rows">
          <div className="rows-head" role="row">
            <span role="columnheader">English</span>
            <span role="columnheader">CrochetPARADE</span>
            <span role="columnheader">Status</span>
          </div>
          {notes
            .filter((n) => !n.section)
            .map((n, i) => (
              <p key={`n${i}`} className="note">
                {n.text}
              </p>
            ))}
          {rows.map((row, i) => (
            <Fragment key={row.id}>
              {row.section && row.section !== rows[i - 1]?.section && <h3 className="section">{row.section}</h3>}
              <RowItem row={row} translation={translations[row.id]} busy={!!busyRows[row.id]} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ n, of, label, tone }: { n: number; of?: number; label: string; tone?: "ask" | "warn" | "bad" }) {
  return (
    <span className={`stat ${tone ?? ""}`}>
      <b>
        {n}
        {of !== undefined && <span className="of">/{of}</span>}
      </b>{" "}
      {label}
    </span>
  );
}

const STATUS: Record<RowTranslation["status"], { mark: string; label: string; tone: string }> = {
  valid: { mark: "✓", label: "valid", tone: "ok" },
  count_mismatch: { mark: "≠", label: "count differs", tone: "warn" },
  invalid: { mark: "✕", label: "failed", tone: "bad" },
  needs_answer: { mark: "?", label: "question", tone: "ask" },
};

function RowItem({ row, translation: t, busy }: { row: PatternRow; translation?: RowTranslation; busy: boolean }) {
  const selected = useApp((s) => s.selectedRowId === row.id);
  const dismissed = useApp((s) => s.dismissed[row.id]);
  const canTranslate = useApp((s) => hasKey(s) && !!s.model && !s.translating);
  const count = useCheck((s) => s.check?.counts[row.id]);
  const parseError = useCheck((s) => (s.check?.errorRowId === row.id ? s.check.result.error?.message : undefined));
  const [editing, setEditing] = useState(false);
  const [editNote, setEditNote] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const commit = async (cp: string) => {
    setEditing(false);
    if (t && cp.trim() === t.cp.trim()) return;
    const checked = await checkRow(row.id, cp);
    setEditNote(checked.message);
    editRow(row.id, cp, checked.status);
  };

  const pick = async (index: number) => {
    answerQuestion(row.id, index);
    const option = t?.question?.options[index];
    if (option?.cp != null) {
      const checked = await checkRow(row.id, option.cp);
      const now = useApp.getState().translations[row.id]!;
      useApp.setState((s) => ({ translations: { ...s.translations, [row.id]: { ...now, status: checked.status } } }));
    }
  };

  const status = busy ? undefined : t && STATUS[t.status];
  const failure = t?.status === "invalid" ? t.attempts.at(-1)?.validation.error?.message ?? t.attempts.at(-1)?.rejected : undefined;
  const notes = (t?.assumptions ?? []).filter((a) => !dismissed?.includes(a));
  const open = t?.question && t.question.answer === undefined;
  const retry = !!t && canTranslate && !busy && (t.status !== "valid" || t.source === "user");

  return (
    <div
      ref={ref}
      role="row"
      className={`row-item ${selected ? "selected" : ""} ${t?.status ?? "pending"} ${busy ? "busy" : ""}`}
      onClick={() => selectRow(selected ? undefined : row.id)}
    >
      <div className="english-cell" role="cell">
        <span className="label">{rowLabel(row)}</span>
        {row.label && <span className="text">{row.text}</span>}
      </div>

      <div className="code-cell" role="cell" onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <CodeEditor
            label={`CrochetPARADE for ${rowLabel(row)}`}
            value={t?.cp ?? ""}
            autoFocus
            onCommit={(v) => void commit(v)}
            onCancel={() => setEditing(false)}
            errors={parseError ? [{ line: 1, message: parseError }] : []}
          />
        ) : (
          <button className={`code ${t?.status === "invalid" ? "struck" : ""}`} onClick={() => (selectRow(row.id), setEditing(true))} title="Edit (Ctrl/⌘-Enter or click away to keep)">
            {busy ? <span className="shimmer">translating</span> : t?.cp.trim() ? t.cp : <span className="faint">{t ? "(no stitches)" : "not translated"}</span>}
          </button>
        )}
        {(parseError || editNote || failure) && !editing && <p className="row-error">{parseError ?? editNote ?? failure}</p>}
      </div>

      <div className="status-cell" role="cell">
        {busy ? (
          <span className="marker busy" aria-label="translating" />
        ) : status ? (
          <>
            <span className={`marker ${status.tone}`} aria-hidden="true">
              <span>{status.mark}</span>
            </span>
            <span className="status-text">
              {status.label}
              <small>
                {count !== undefined && row.statedCount !== undefined
                  ? `${count} sts, ${row.statedCount} stated`
                  : count !== undefined
                    ? `${count} sts`
                    : row.statedCount !== undefined
                      ? `${row.statedCount} stated`
                      : ""}
              </small>
              <small>
                {t!.source === "user" ? "your edit" : t!.source === "gold" ? "sample" : `${t!.confidence} confidence${t!.cached ? ", cached" : ""}`}
              </small>
            </span>
          </>
        ) : (
          <span className="faint">—</span>
        )}
      </div>

      {(t?.question || notes.length > 0 || retry) && (
        <div className="row-extra" onClick={(e) => e.stopPropagation()}>
          {t?.question && (
            <div className={`question ${open ? "open" : "answered"}`}>
              <p>
                <strong>Question.</strong> {t.question.text}
              </p>
              <div className="options">
                {t.question.options.map((o, i) => (
                  <button key={i} className={t.question!.answer === i ? "option chosen" : "option"} onClick={() => void pick(i)} disabled={busy}>
                    {o.label}
                    {o.cp != null && <code>{o.cp}</code>}
                  </button>
                ))}
              </div>
              {open && <p className="hint">Until you answer, the model uses the translator’s best guess.</p>}
            </div>
          )}
          {notes.length > 0 && (
            <ul className="assumptions">
              {notes.map((a) => (
                <li key={a}>
                  <span>{a}</span>
                  <button className="link" onClick={() => dismissAssumption(row.id, a)}>
                    Fine
                  </button>
                  <button className="link" disabled={!canTranslate || busy} onClick={() => rejectAssumption(row.id, a)} title="Re-translate this row without this assumption">
                    Wrong, retranslate
                  </button>
                </li>
              ))}
            </ul>
          )}
          {retry && (
            <button className="link" onClick={() => void retranslateRow(row.id)}>
              {t!.source === "user" ? "Replace my edit with a new translation" : "Translate this row again"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The whole pattern as CrochetPARADE with the English as comments (FR-6.1, FR-6.4). */
function WholeCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "pattern.crochetparade.txt" });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="whole-code">
      <div className="row-actions">
        <button className="button small" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="button small" onClick={download}>
          Download
        </button>
        <a className="button small" href="https://www.crochetparade.org/" target="_blank" rel="noreferrer noopener" onClick={() => void copy()}>
          Copy and open CrochetPARADE
        </a>
        <span className="hint">Edit rows in the Rows view; failed rows are commented out.</span>
      </div>
      <CodeEditor label="Whole pattern" value={text} readOnly gutter />
    </div>
  );
}
