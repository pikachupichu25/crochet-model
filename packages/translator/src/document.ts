// Document mode: the English pattern as written in, one CrochetPARADE text
// out. An alternative to row mode for evaluation (docs/REQUIREMENTS.md §9).
//
//   one request with the pattern as written (no row ids, no segmentation)
//   up to N attempts: validate the whole text; accept when it parses and each
//     instruction with a stated count makes it; otherwise send the parser
//     error or the count differences back and ask for the whole text again
//   not accepted: keep the best attempt (parses > does not; then fewer count
//     differences)
//
// The model heads each instruction's lines with a `# <label>` comment, as the
// worked examples do. The segmenter is used only to check counts: a comment
// that names a segmented row's label ties the lines under it to that row's
// stated count. Comments that match no row are not checked.
//
// The result has one translation, for a row with id "document" that stands for
// all the English not given; given rows (a step item's gold prefix) keep their
// own rows, so `assemble` works as in the other modes. The app wants a
// translation per row instead: `documentRows` splits the text at the same
// comments and checks each row in turn, as whole mode does.

import {
  countMatches,
  lastRowCount,
  type Attempt,
  type PatternRow,
  type RowTranslation,
  type ValidationResult,
} from "@crochet-model/core";
import {
  addUsage,
  failed,
  joinCp,
  safeJson,
  settingsOf,
  summary,
  userTurn,
  zeroUsage,
  type TranslateInput,
  type TranslateOptions,
  type TranslateResult,
} from "./loop.ts";
import { isFatal, type ModelReply, type Turn } from "./model.ts";
import {
  documentBlock,
  documentCountRepair,
  documentParseRepair,
  documentSystemBlocks,
  formatRepair,
  promptVersion,
} from "./prompt.ts";
import { DocumentResponse, outputFormat } from "./schema.ts";

export const DOCUMENT_ROW_ID = "document";

const DEFAULT_ATTEMPTS = 3;
// The whole pattern in one reply, after thinking: more room than one row.
const DEFAULT_MAX_TOKENS = 32_000;

export async function translateDocument(input: TranslateInput, o: TranslateOptions): Promise<TranslateResult> {
  const given = input.rows.filter((r) => input.given?.[r.id] !== undefined);
  const todo = input.rows.filter((r) => input.given?.[r.id] === undefined);
  const prefix = joinCp(given.map((r) => input.given![r.id]!));
  // With no given rows, the English goes exactly as written.
  const english = given.length ? todo.map(rowText).join("\n") : input.english;

  const usage = zeroUsage();
  const models = new Set<string>();
  let requests = 0;
  let cost: number | undefined = 0;
  const send = async (attempt: number, messages: Turn[]): Promise<ModelReply> => {
    o.signal?.throwIfAborted();
    requests += 1;
    const reply = await o.model.send({
      id: `${o.idPrefix}-document-${attempt}`,
      model: o.modelName,
      effort: attempt ? o.repairEffort : o.effort,
      system: documentSystemBlocks(),
      messages,
      schema: outputFormat(DocumentResponse).schema,
      maxTokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
    addUsage(usage, reply.usage);
    models.add(reply.model);
    if (cost !== undefined) cost = reply.costUsd === undefined ? undefined : cost + reply.costUsd;
    return reply;
  };

  const messages: Turn[] = [
    {
      role: "user",
      blocks: [documentBlock(english, given.length ? { english: given.map(rowText).join("\n"), cp: prefix } : undefined)],
    },
  ];
  const maxAttempts = o.maxAttempts ?? DEFAULT_ATTEMPTS;
  const attempts: Attempt[] = [];
  let chosen: { cp: string; ok: boolean; mismatches: number; assumptions: string[] } | undefined;
  const choose = (c: NonNullable<typeof chosen>) => {
    if (!chosen || (c.ok && !chosen.ok) || (c.ok === chosen.ok && c.mismatches <= chosen.mismatches)) chosen = c;
  };
  const rejected = (why: string, reply?: ModelReply, rejected = why): Attempt => ({
    cp: "",
    validation: failed(why),
    provider: o.model.provider,
    model: reply?.model ?? o.modelName,
    usage: reply?.usage ?? zeroUsage(),
    rejected,
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let reply: ModelReply;
    try {
      reply = await send(attempt, messages);
    } catch (error) {
      if (isFatal(error) || o.signal?.aborted) throw error;
      attempts.push(rejected(`request failed: ${String(error)}`, undefined, "request failed"));
      break;
    }
    messages.push({ role: "assistant", text: reply.text, raw: reply.raw });
    if (reply.stopReason === "refusal") {
      attempts.push(rejected("refused", reply, "refusal"));
      break;
    }
    const parsed = safeJson(reply.text, DocumentResponse);
    if (!parsed.ok) {
      const why = reply.stopReason === "max_tokens" ? "it was cut off at the token limit" : parsed.why;
      attempts.push(rejected(why, reply, "unusable response"));
      messages.push(userTurn(formatRepair(why, true)));
      continue;
    }
    const cp = parsed.value.cp.trim();
    const full = joinCp([prefix, cp]);
    const result = o.validate(full);
    attempts.push({
      cp,
      validation: summary(result),
      provider: o.model.provider,
      model: reply.model,
      usage: reply.usage,
      ...(result.ok ? {} : { rejected: "parse error" }),
    });
    if (!result.ok) {
      choose({ cp, ok: false, mismatches: Infinity, assumptions: parsed.value.assumptions });
      const error = result.error!;
      const line = error.line === undefined ? undefined : full.split("\n")[error.line - 1];
      messages.push(userTurn(documentParseRepair(error, line)));
      continue;
    }
    const mismatches = countMismatches(prefix, cp, todo, o.validate);
    choose({ cp, ok: true, mismatches: mismatches.length, assumptions: parsed.value.assumptions });
    if (mismatches.length === 0 || attempt === maxAttempts - 1) break;
    attempts[attempts.length - 1]!.rejected = "count mismatch";
    messages.push(userTurn(documentCountRepair(mismatches)));
  }

  const translation: RowTranslation = {
    rowId: DOCUMENT_ROW_ID,
    cp: chosen?.cp ?? "",
    source: "llm",
    status: !chosen?.ok ? "invalid" : chosen.mismatches === 0 ? "valid" : "count_mismatch",
    confidence: "medium",
    assumptions: chosen?.assumptions ?? [],
    attempts,
  };
  const translations: Record<string, RowTranslation> = { [DOCUMENT_ROW_ID]: translation };
  for (const row of given) {
    translations[row.id] = {
      rowId: row.id,
      cp: input.given![row.id]!,
      source: "gold",
      status: "valid",
      confidence: "high",
      assumptions: [],
      attempts: [],
    };
  }
  return {
    pattern: {
      english: input.english,
      rows: [...given, { id: DOCUMENT_ROW_ID, label: "", text: english, span: 1 }],
      translations,
      answers: {},
      colors: input.colors ?? {},
      promptVersion: promptVersion(settingsOf({ ...o, provider: o.model.provider }, "document")),
      provider: o.model.provider,
      model: o.modelName,
    },
    usage,
    requests,
    models: [...models],
    ...(requests && cost !== undefined ? { costUsd: cost } : {}),
  };
}

function rowText(row: PatternRow): string {
  return row.label ? `${row.label}: ${row.text}` : row.text;
}

/** A comment and the lines under it, up to the next comment. */
interface Block {
  header?: string;
  body: string;
}

/** Splits the text at whole-line `#` comments; text before the first comment has no header. */
export function commentBlocks(cp: string): Block[] {
  const blocks: Block[] = [{ body: "" }];
  for (const line of cp.split("\n")) {
    const comment = /^\s*#\s*(.*)$/.exec(line);
    if (comment) blocks.push({ header: comment[1]!, body: "" });
    else blocks[blocks.length - 1]!.body += `${line}\n`;
  }
  return blocks.filter((b, i) => i > 0 || b.body.trim());
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Does `text` start with `start` as whole words? "Rnd 3" starts "Rnd 3: sc around", not "Rnd 30". */
function startsWith(text: string, start: string): boolean {
  const t = normalize(text);
  const s = normalize(start).replace(/[.:,]+$/, "");
  return s !== "" && (t === s || (t.startsWith(s) && /^[^a-z0-9]/.test(t.slice(s.length))));
}

/**
 * Does a comment name this row? A labelled row by its label; an unlabelled one
 * ("Ch 16.") by the first words of its text, as the prompt asks.
 */
function names(header: string, row: PatternRow): boolean {
  return row.label ? startsWith(header, row.label) : startsWith(row.text, header);
}

/**
 * The row each comment block names, by block index. Rows are matched in
 * order, so a label used in two sections ("Rnd 1" of the head and of an arm)
 * goes to the next one each time.
 */
function matchBlocks(blocks: Block[], rows: PatternRow[]): (PatternRow | undefined)[] {
  let next = 0;
  return blocks.map((block) => {
    if (block.header === undefined) return undefined;
    const i = rows.findIndex((r, j) => j >= next && names(block.header!, r));
    if (i < 0) return undefined;
    next = i + 1;
    return rows[i];
  });
}

/**
 * Each row's lines, by row id, without the comments. A block that names no
 * row joins the row before it (or the first row), so no line is lost.
 */
export function splitDocument(cp: string, rows: PatternRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const blocks = commentBlocks(cp);
  const matched = matchBlocks(blocks, rows);
  let current = rows[0]?.id;
  blocks.forEach((block, i) => {
    current = matched[i]?.id ?? current;
    if (current === undefined) return;
    if (matched[i]) out.set(current, out.get(current) ?? "");
    const body = block.body.trim();
    if (body) out.set(current, joinCp([out.get(current) ?? "", body]));
  });
  return out;
}

/** The instructions whose last line does not make the stated count. */
export function countMismatches(
  prefix: string,
  cp: string,
  rows: PatternRow[],
  validate: TranslateOptions["validate"],
): string[] {
  const out: string[] = [];
  const parts = [prefix];
  // Parser rows before the current block, recounted after unchecked blocks.
  let rowsBefore = 0;
  let stale = prefix.trim() !== "";
  const blocks = commentBlocks(cp);
  const matched = matchBlocks(blocks, rows);
  for (const [i, block] of blocks.entries()) {
    const row = matched[i];
    if (row?.statedCount === undefined || !block.body.trim()) {
      parts.push(block.body);
      if (block.body.trim()) stale = true;
      continue;
    }
    if (stale) {
      const before = validate(joinCp(parts));
      if (before.ok) rowsBefore = before.rows.length;
      stale = false;
    }
    parts.push(block.body);
    const result = validate(joinCp(parts));
    if (!result.ok) continue;
    if (result.rows.length > rowsBefore) {
      const check = lastRowCount(result);
      if (!countMatches(check, row.statedCount)) {
        out.push(`${row.label || row.text}: the English states ${row.statedCount}, the parser counts ${check?.parsed} on its last line`);
      }
    }
    rowsBefore = result.rows.length;
  }
  return out;
}

/**
 * One translation per row from a document-mode result (the app's review).
 * Rows are checked in order against the rows before them: a row that parses is
 * valid or count_mismatch, one that does not is invalid and left out of the
 * prefix. `fixed` rows (the user's own code) take the place of the model's.
 * Assumptions go to the row whose label they start with, else the first row;
 * the attempts go with the first row.
 */
export function documentRows(
  document: RowTranslation,
  rows: PatternRow[],
  validate: TranslateOptions["validate"],
  fixed: Record<string, RowTranslation> = {},
): RowTranslation[] {
  // No text at all: the request failed or was refused.
  const empty = !document.cp.trim();
  const split = splitDocument(document.cp, rows);
  const assumptions = new Map<string, string[]>();
  for (const a of document.assumptions) {
    const row = rows.find((r) => r.label && startsWith(a, r.label)) ?? rows[0];
    if (row) assumptions.set(row.id, [...(assumptions.get(row.id) ?? []), a]);
  }
  const accepted: string[] = [];
  let rowsBefore = 0;
  return rows.map((row, i) => {
    const own = fixed[row.id];
    const cp = own?.cp ?? split.get(row.id) ?? "";
    const missing = !own && !split.has(row.id);
    let result: ValidationResult | undefined;
    let status: RowTranslation["status"] = empty && !own ? "invalid" : "valid";
    // A row with a stated count that got no lines (often merged into the row before).
    if (missing && !empty && row.statedCount !== undefined) status = "count_mismatch";
    if (cp.trim()) {
      result = validate(joinCp([...accepted, cp]));
      if (!result.ok) status = "invalid";
      else if (result.rows.length > rowsBefore && !countMatches(lastRowCount(result), row.statedCount)) status = "count_mismatch";
    }
    if (status !== "invalid") {
      accepted.push(cp);
      if (result) rowsBefore = result.rows.length;
    }
    if (own) return { ...own, status: own.source === "user" ? status : own.status, attempts: [] };
    return {
      rowId: row.id,
      cp,
      source: "llm",
      status,
      confidence: missing ? "low" : document.confidence,
      assumptions: [
        ...(missing && !empty ? ["The whole-pattern translation has no lines marked for this row."] : []),
        ...(assumptions.get(row.id) ?? []),
      ],
      attempts: i === 0 ? document.attempts : [],
    };
  });
}
