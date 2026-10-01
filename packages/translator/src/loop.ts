// Translate → validate → repair (docs/SPEC.md §5.5).
//
//   for each row, in order:
//     ask for the row
//     up to N attempts: validate prefix + amendments + row; accept when it
//       parses and makes the stated count; otherwise send the parser error or
//       the count difference back and ask again
//     not accepted: keep the best attempt; a parsing one joins the prefix
//       (count_mismatch), a failing one does not (invalid)
//
// Decisions beyond the spec:
// - A stated count matches the parser's count allowing for an uncounted
//   beginning chain (counts.ts).
// - When the model says the parser's count differs from the English on
//   purpose (`expectedCount` equals the parsed count, not the stated one), the
//   row is accepted as count_mismatch without more repairs.
// - An amendment is "labels only" when the amended prefix makes the same stitch
//   graph as before (compare.ts), which is exactly what a label cannot change.

import { createHash } from "node:crypto";
import {
  canonicalRows,
  countMatches,
  lastRowCount,
  parseStitchGraph,
  type Attempt,
  type PatternNote,
  type PatternRow,
  type Question,
  type RowTranslation,
  type TranslatedPattern,
  type Usage,
  type ValidationResult,
} from "@crochet-model/core";
import { isFatal, type Effort, type ModelReply, type TranslatorModel, type Turn } from "./model.ts";
import {
  amendmentRepair,
  countRepair,
  formatRepair,
  parseErrorRepair,
  patternBlock,
  promptVersion,
  rowBlock,
  systemBlocks,
  wholeBlock,
  type AcceptedRow,
  type PatternContext,
} from "./prompt.ts";
import { confidenceOf, outputFormat, RowResponse, WholeResponse } from "./schema.ts";

export interface QuestionContext {
  row: PatternRow;
  rowIndex: number;
  question: Question;
  /** The accepted CrochetPARADE before this row. */
  prefix: string;
}

export interface TranslateOptions {
  model: TranslatorModel;
  modelName: string;
  effort: Effort;
  repairEffort: Effort;
  /** 3 by default; 1 turns repair off. */
  maxAttempts?: number;
  maxTokens?: number;
  validate: (text: string) => ValidationResult;
  /** Answers a question by option index; undefined leaves the row needs_answer. */
  answer?: (context: QuestionContext) => number | undefined;
  /** Prefix for request ids, unique per pattern within a run. */
  idPrefix: string;
  /** Called as each row is settled, and again for an earlier row when a later one amends it. */
  onRow?: (translation: RowTranslation) => void;
  /** Translate only these rows (and accept fixed ones); stop after the last of them. */
  only?: string[];
  /** Row translations kept between patterns (SPEC §8.4); rows found here send no request. */
  cache?: RowCache;
  /** Stops before the next request once aborted (the app's user went away). */
  signal?: AbortSignal;
}

export interface TranslateInput {
  english: string;
  rows: PatternRow[];
  notes?: PatternNote[];
  colors?: Record<string, string>;
  /** Rows already translated, by row id (the gold prefix of a step item). */
  given?: Record<string, string>;
  /**
   * Rows whose translation is already settled, by row id: rows the user
   * edited, or earlier rows when one row is re-translated. They join the
   * prefix unless invalid. A `user` row is never amended (FR-3.3); an `llm`
   * row may gain labels.
   */
  fixed?: Record<string, RowTranslation>;
  /** Assumptions the user rejected, by row id; sent with that row's request (FR-3.4). */
  rejected?: Record<string, string[]>;
}

/** A row as the loop accepted it, before the user's answer is applied. */
export interface CachedRow {
  response: RowResponse;
  /** Earlier rows it amended, by row id. */
  amended: [string, string][];
  status: "valid" | "count_mismatch";
  attempts: Attempt[];
}

export interface RowCache {
  get(key: string): CachedRow | undefined;
  set(key: string, value: CachedRow): void;
}

export interface TranslateResult {
  pattern: TranslatedPattern;
  usage: Usage;
  /** Requests sent. */
  requests: number;
  /** The models that answered, when a fallback took over. */
  models: string[];
  /** US$ as the provider reported it, when every reply carried a cost (OpenRouter). */
  costUsd?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_TOKENS = 16_000;

export function settingsOf(
  o: Pick<TranslateOptions, "modelName" | "effort" | "repairEffort" | "maxAttempts"> & { provider: string },
  mode: "row" | "whole",
) {
  return {
    mode,
    provider: o.provider,
    model: o.modelName,
    effort: o.effort,
    repairEffort: o.repairEffort,
    maxAttempts: o.maxAttempts ?? DEFAULT_ATTEMPTS,
  };
}

/** The accepted CrochetPARADE, in row order: rows that are not invalid. */
export function assemble(pattern: TranslatedPattern, options: { skipGiven?: boolean } = {}): string {
  return joinCp(
    pattern.rows.flatMap((row) => {
      const t = pattern.translations[row.id];
      if (!t || t.status === "invalid") return [];
      if (options.skipGiven && t.source === "gold") return [];
      return [t.cp];
    }),
  );
}

function joinCp(parts: string[]): string {
  return parts.map((p) => p.trim()).filter((p) => p !== "").join("\n");
}

function addUsage(total: Usage, u: Usage) {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens += u.cacheReadTokens;
  total.cacheWriteTokens += u.cacheWriteTokens;
}

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function summary(result: ValidationResult): Attempt["validation"] {
  const { graphJson, simpleDot, ...rest } = result;
  void graphJson;
  void simpleDot;
  return rest;
}

const failed = (message: string): Attempt["validation"] => ({
  ok: false,
  rows: [],
  warnings: [],
  error: { kind: "other", message, raw: message },
});

/** Parser rows added by the last part of `result`, after `before` rows. */
function newParserRows(result: ValidationResult, before: number): AcceptedRow["parserRows"] {
  return result.rows.slice(before).map((r) => ({ row: r.row, count: r.stitches }));
}

type Candidate = {
  response: RowResponse;
  amended: Map<string, string>;
  result?: ValidationResult;
  countOk: boolean;
  countError: number;
};

class PatternTranslator {
  private accepted: AcceptedRow[] = [];
  private translations: Record<string, RowTranslation> = {};
  private context: PatternContext;
  private usage = zeroUsage();
  private requests = 0;
  private models = new Set<string>();
  /** Undefined once a reply has no reported cost. */
  private cost: number | undefined = 0;

  private input: TranslateInput;
  private o: TranslateOptions;

  constructor(input: TranslateInput, o: TranslateOptions) {
    this.input = input;
    this.o = o;
    this.context = {
      rows: input.rows,
      notes: input.notes ?? [],
      colors: input.colors ?? {},
      answers: [],
    };
  }

  private prefixText(accepted = this.accepted): string {
    return joinCp(accepted.map((a) => a.cp));
  }

  private parserRowCount(): number {
    const last = this.accepted.flatMap((a) => a.parserRows).at(-1);
    return last ? last.row + 1 : 0;
  }

  private async send(id: string, effort: Effort, messages: Turn[], whole: boolean): Promise<ModelReply> {
    this.o.signal?.throwIfAborted();
    this.requests += 1;
    const reply = await this.o.model.send({
      id: `${this.o.idPrefix}-${id}`,
      model: this.o.modelName,
      effort,
      system: systemBlocks(),
      messages,
      schema: outputFormat(whole ? WholeResponse : RowResponse).schema,
      maxTokens: this.o.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
    addUsage(this.usage, reply.usage);
    this.models.add(reply.model);
    if (this.cost !== undefined) this.cost = reply.costUsd === undefined ? undefined : this.cost + reply.costUsd;
    return reply;
  }

  /** Gold rows: accepted as given, with their parser rows worked out. */
  private acceptGiven(row: PatternRow, cp: string) {
    const before = this.parserRowCount();
    const result = this.o.validate(joinCp([this.prefixText(), cp]));
    this.accepted.push({ row, cp, parserRows: result.ok ? newParserRows(result, before) : [], given: true });
    this.translations[row.id] = {
      rowId: row.id,
      cp,
      source: "gold",
      status: result.ok ? "valid" : "invalid",
      confidence: "high",
      assumptions: [],
      attempts: [],
    };
  }

  /** A settled row, as it is: it joins the prefix unless invalid. */
  private acceptFixed(row: PatternRow, settled: RowTranslation) {
    // A copy: an amendment changes it in place.
    const translation = { ...settled };
    this.translations[row.id] = translation;
    const q = translation.question;
    if (q?.answer !== undefined) this.context.answers.push({ rowId: row.id, question: q, answer: q.answer });
    const before = this.parserRowCount();
    const result = translation.cp.trim() ? this.o.validate(joinCp([this.prefixText(), translation.cp])) : undefined;
    // A user's edit is checked here, as the loop checks its own rows.
    if (translation.source === "user") {
      const count = result?.ok && result.rows.length > before ? lastRowCount(result) : undefined;
      translation.status = result && !result.ok ? "invalid" : countMatches(count, row.statedCount) || !count ? "valid" : "count_mismatch";
    }
    if (translation.status === "invalid") return;
    this.accepted.push({
      row,
      cp: translation.cp,
      parserRows: result?.ok ? newParserRows(result, before) : [],
      given: translation.source === "user" || translation.source === "gold",
    });
  }

  async translateRows(): Promise<void> {
    const only = this.o.only ? new Set(this.o.only) : undefined;
    let left = only?.size ?? Infinity;
    for (const [i, row] of this.input.rows.entries()) {
      if (left === 0) break;
      const given = this.input.given?.[row.id];
      const fixed = this.input.fixed?.[row.id];
      if (given !== undefined) this.acceptGiven(row, given);
      else if (fixed && !only?.has(row.id)) this.acceptFixed(row, fixed);
      else if (!only || only.has(row.id)) {
        await this.translateRow(row, i);
        this.o.onRow?.(this.translations[row.id]!);
      }
      if (only?.has(row.id)) left -= 1;
    }
  }

  /** Identifies everything a row's request depends on (SPEC §8.4). */
  private cacheKey(target: PatternRow, prefix: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.version,
          this.input.english,
          this.context.colors,
          this.context.answers.map((a) => [a.rowId, a.answer]),
          target.id,
          prefix,
        ]),
      )
      .digest("hex");
  }

  private versionText: string | undefined;
  private get version(): string {
    return (this.versionText ??= promptVersion(settingsOf({ ...this.o, provider: this.o.model.provider }, "row")));
  }

  private async translateRow(target: PatternRow, rowIndex: number): Promise<void> {
    const maxAttempts = this.o.maxAttempts ?? DEFAULT_ATTEMPTS;
    const prefix = this.prefixText();
    const prefixRows = this.parserRowCount();
    const cacheKey = this.o.cache ? this.cacheKey(target, prefix) : undefined;
    const hit = cacheKey ? this.o.cache!.get(cacheKey) : undefined;
    if (hit && this.replayCached(target, rowIndex, hit, prefix, prefixRows)) return;

    const oldGraph = prefix ? this.graphRows(prefix) : [];
    const afterInvalid = Object.values(this.translations).some((t) => t.status === "invalid");
    const messages: Turn[] = [
      { role: "user", blocks: [patternBlock(this.context), rowBlock(this.accepted, target, this.input.rejected?.[target.id])] },
    ];
    const attempts: Attempt[] = [];

    let accepted: (Candidate & { status: RowTranslation["status"] }) | undefined;
    let best: Candidate | undefined;
    const better = (a: Candidate, b: Candidate | undefined) => {
      if (!b) return true;
      const rank = (c: Candidate) => (c.result?.ok ? (c.countOk ? 2 : 1) : 0);
      if (rank(a) !== rank(b)) return rank(a) > rank(b);
      return a.countError < b.countError;
    };

    for (let attempt = 0; attempt < maxAttempts && !accepted; attempt++) {
      let reply: ModelReply;
      try {
        reply = await this.send(`${target.id}-${attempt}`, attempt ? this.o.repairEffort : this.o.effort, messages, false);
      } catch (error) {
        if (isFatal(error) || this.o.signal?.aborted) throw error;
        attempts.push({ cp: "", validation: failed(`request failed: ${String(error)}`), provider: this.o.model.provider, model: this.o.modelName, usage: zeroUsage(), rejected: "request failed" });
        break;
      }
      const record = (cp: string, validation: Attempt["validation"], rejected?: string) =>
        attempts.push({ cp, validation, provider: this.o.model.provider, model: reply.model, usage: reply.usage, ...(rejected ? { rejected } : {}) });
      messages.push({ role: "assistant", text: reply.text, raw: reply.raw });

      if (reply.stopReason === "refusal") {
        record("", failed("refused"), "refusal");
        break;
      }
      const parsed = safeJson(reply.text, RowResponse);
      if (!parsed.ok) {
        const why = reply.stopReason === "max_tokens" ? "it was cut off at the token limit" : parsed.why;
        record("", failed(why), "unusable response");
        messages.push(userTurn(formatRepair(why)));
        continue;
      }
      const response = parsed.value;
      const cp = response.cp.trim();

      // Amendments: labels only, on rows already accepted.
      const amended = new Map<string, string>();
      let amendError: string | undefined;
      for (const a of response.amendPrevious) {
        const earlier = this.accepted.find((r) => r.row.id === a.rowId);
        if (!earlier) {
          amendError = `[${a.rowId}] is not an earlier row`;
          break;
        }
        // Given rows are fixed: the evaluation scores against them unchanged.
        if (earlier.given) {
          amendError = `[${a.rowId}] is given and cannot be changed; write the target without new labels on it`;
          break;
        }
        amended.set(a.rowId, a.cp.trim());
      }
      if (!amendError && amended.size) {
        const newPrefix = joinCp(this.accepted.map((r) => amended.get(r.row.id) ?? r.cp));
        const check = this.o.validate(newPrefix);
        if (!check.ok) amendError = `the amended rows do not parse: ${check.error!.message}`;
        else if (JSON.stringify(canonicalRows(parseStitchGraph(check.graphJson!))) !== JSON.stringify(oldGraph))
          amendError = "it changes the stitches, not only labels";
      }
      if (amendError) {
        const rowId = response.amendPrevious[0]?.rowId ?? "?";
        record(cp, failed(`amendment rejected: ${amendError}`), "amendment rejected");
        messages.push(userTurn(amendmentRepair(rowId, amendError, target)));
        continue;
      }

      if (cp === "") {
        record(cp, { ok: true, rows: [], warnings: [] });
        accepted = { response, amended, countOk: true, countError: 0, status: "valid" };
        break;
      }

      const text = joinCp([...this.accepted.map((r) => amended.get(r.row.id) ?? r.cp), cp]);
      const result = this.o.validate(text);
      if (!result.ok) {
        record(cp, summary(result), "parse error");
        const c: Candidate = { response, amended, result, countOk: false, countError: Infinity };
        if (better(c, best)) best = c;
        messages.push(userTurn(parseErrorRepair(result.error!, target)));
        continue;
      }

      const stated = target.statedCount;
      const madeStitches = result.rows.length > prefixRows;
      const check = madeStitches ? lastRowCount(result) : undefined;
      const countOk = !madeStitches || countMatches(check, stated);
      const countError =
        stated === undefined || !check ? 0 : Math.min(...check.accepted.map((n) => Math.abs(n - stated)));
      const c: Candidate = { response, amended, result, countOk, countError };
      if (countOk) {
        record(cp, summary(result));
        accepted = { ...c, status: "valid" };
      } else if (response.expectedCount === check!.parsed) {
        record(cp, summary(result), "count differs from the English, as the model intended");
        accepted = { ...c, status: "count_mismatch" };
      } else if (afterInvalid) {
        // An earlier row is missing from the prefix, so the count is expected
        // to be off: flag it, do not repair (SPEC §5.5).
        record(cp, summary(result), `count ${check!.accepted.join(" or ")}, stated ${stated}; not repaired after an invalid row`);
        accepted = { ...c, status: "count_mismatch" };
      } else {
        record(cp, summary(result), `count ${check!.accepted.join(" or ")}, stated ${stated}`);
        if (better(c, best)) best = c;
        messages.push(userTurn(countRepair(stated!, check!, target)));
      }
    }

    const final = accepted ?? (best?.result?.ok ? { ...best, status: "count_mismatch" as const } : undefined);
    if (!final) {
      const last = best?.response;
      this.translations[target.id] = {
        rowId: target.id,
        cp: last?.cp.trim() ?? attempts.at(-1)?.cp ?? "",
        source: "llm",
        status: "invalid",
        confidence: "low",
        assumptions: last?.assumptions ?? [],
        attempts,
      };
      return;
    }

    if (cacheKey) {
      this.o.cache!.set(cacheKey, {
        response: final.response,
        amended: [...final.amended],
        status: final.status === "count_mismatch" ? "count_mismatch" : "valid",
        attempts,
      });
    }
    this.settle(target, rowIndex, final, attempts, prefix, prefixRows);
  }

  /** A cached row, settled as if just translated; false when it no longer parses here. */
  private replayCached(target: PatternRow, rowIndex: number, hit: CachedRow, prefix: string, prefixRows: number): boolean {
    const amended = new Map(hit.amended);
    const cp = hit.response.cp.trim();
    let result: ValidationResult | undefined;
    if (cp) {
      result = this.o.validate(joinCp([...this.accepted.map((r) => amended.get(r.row.id) ?? r.cp), cp]));
      if (!result.ok) return false;
    }
    const candidate = { response: hit.response, amended, result, countOk: hit.status === "valid", countError: 0, status: hit.status };
    this.settle(target, rowIndex, candidate, hit.attempts, prefix, prefixRows);
    this.translations[target.id]!.cached = true;
    return true;
  }

  /** Applies the answer and the amendments, and adds the row to the prefix. */
  private settle(
    target: PatternRow,
    rowIndex: number,
    final: Candidate & { status: RowTranslation["status"] },
    attempts: Attempt[],
    prefix: string,
    prefixRows: number,
  ): void {
    let cp = final.response.cp.trim();
    let status = final.status;
    let result = final.result;
    const translation: RowTranslation = {
      rowId: target.id,
      cp,
      source: "llm",
      status,
      confidence: confidenceOf(final.response.confidence),
      assumptions: final.response.assumptions,
      attempts,
    };

    // Questions: the evaluation may answer; otherwise the best guess stands.
    const q = final.response.question;
    if (q && q.options.length >= 2) {
      const question: Question = { text: q.text, options: q.options };
      translation.question = question;
      const answer = this.o.answer?.({ row: target, rowIndex, question, prefix });
      const option = answer === undefined ? undefined : question.options[answer];
      if (answer !== undefined && option) {
        question.answer = answer;
        this.context.answers.push({ rowId: target.id, question, answer });
        if (option.cp !== null && option.cp.trim() !== cp) {
          const text = joinCp([...this.accepted.map((r) => final.amended.get(r.row.id) ?? r.cp), option.cp]);
          const checked = this.o.validate(text);
          if (checked.ok) {
            cp = option.cp.trim();
            result = checked;
            const count = result.rows.length > prefixRows ? lastRowCount(result) : undefined;
            status = !count || countMatches(count, target.statedCount) ? "valid" : "count_mismatch";
          }
        }
      } else {
        status = "needs_answer";
      }
      translation.cp = cp;
      translation.status = status;
    }

    // Apply amendments to the earlier rows.
    for (const [rowId, amendedCp] of final.amended) {
      const earlier = this.accepted.find((r) => r.row.id === rowId)!;
      earlier.cp = amendedCp;
      const t = this.translations[rowId]!;
      t.cp = amendedCp;
      t.assumptions = [...t.assumptions, `labels added for row [${target.id}]`];
      this.o.onRow?.(t);
    }

    this.translations[target.id] = translation;
    this.accepted.push({
      row: target,
      cp,
      parserRows: cp && result ? newParserRows(result, prefixRows) : [],
    });
  }

  private graphRows(text: string): string[][] {
    const r = this.o.validate(text);
    return r.ok ? canonicalRows(parseStitchGraph(r.graphJson!)) : [];
  }

  /** Whole-pattern mode: every untranslated row in one request, repaired as a whole. */
  async translateWhole(): Promise<void> {
    const todo = this.input.rows.filter((r) => this.input.given?.[r.id] === undefined);
    for (const row of this.input.rows) {
      const given = this.input.given?.[row.id];
      if (given !== undefined) this.acceptGiven(row, given);
    }
    const givenRows = [...this.accepted];
    const messages: Turn[] = [
      { role: "user", blocks: [patternBlock(this.context), wholeBlock(todo, givenRows)] },
    ];
    const maxAttempts = this.o.maxAttempts ?? DEFAULT_ATTEMPTS;
    const attempts: Attempt[] = [];
    // The best attempt: parses > does not parse; then fewer count mismatches.
    let chosen: { cps: Map<string, string>; ok: boolean; mismatches: number; assumptions: string[] } | undefined;
    const choose = (c: NonNullable<typeof chosen>) => {
      if (!chosen || (c.ok && !chosen.ok) || (c.ok === chosen.ok && c.mismatches <= chosen.mismatches)) chosen = c;
    };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let reply: ModelReply;
      try {
        reply = await this.send(`whole-${attempt}`, attempt ? this.o.repairEffort : this.o.effort, messages, true);
      } catch (error) {
        if (isFatal(error) || this.o.signal?.aborted) throw error;
        attempts.push({ cp: "", validation: failed(`request failed: ${String(error)}`), provider: this.o.model.provider, model: this.o.modelName, usage: zeroUsage(), rejected: "request failed" });
        break;
      }
      messages.push({ role: "assistant", text: reply.text, raw: reply.raw });
      if (reply.stopReason === "refusal") {
        attempts.push({ cp: "", validation: failed("refused"), provider: this.o.model.provider, model: reply.model, usage: reply.usage, rejected: "refusal" });
        break;
      }
      const parsed = safeJson(reply.text, WholeResponse);
      if (!parsed.ok) {
        const why = reply.stopReason === "max_tokens" ? "it was cut off at the token limit" : parsed.why;
        attempts.push({ cp: "", validation: failed(why), provider: this.o.model.provider, model: reply.model, usage: reply.usage, rejected: "unusable response" });
        messages.push(userTurn(formatRepair(why, true)));
        continue;
      }
      const cps = new Map(parsed.value.rows.map((r) => [r.rowId, r.cp.trim()]));
      const text = joinCp(this.input.rows.map((r) => this.input.given?.[r.id] ?? cps.get(r.id) ?? ""));
      const result = this.o.validate(text);
      attempts.push({ cp: text, validation: summary(result), provider: this.o.model.provider, model: reply.model, usage: reply.usage, ...(result.ok ? {} : { rejected: "parse error" }) });
      if (!result.ok) {
        choose({ cps, ok: false, mismatches: Infinity, assumptions: parsed.value.assumptions });
        messages.push(
          userTurn(
            `The parser rejected the pattern${result.error!.row === undefined ? "" : ` at parser row ${result.error!.row}`}:\n${result.error!.message}\n\nReturn the corrected response for every row.`,
          ),
        );
        continue;
      }
      const mismatches = this.wholeCountMismatches(cps);
      choose({ cps, ok: true, mismatches: mismatches.length, assumptions: parsed.value.assumptions });
      if (mismatches.length === 0 || attempt === maxAttempts - 1) break;
      messages.push(
        userTurn(
          `The pattern parses, but these rows do not make their stated counts:\n${mismatches.join("\n")}\n\nReturn the corrected response for every row.`,
        ),
      );
    }

    // Per-row status: rows of a pattern that parses are valid or count_mismatch.
    let before = this.parserRowCount();
    for (const row of todo) {
      const cp = chosen?.cps.get(row.id) ?? "";
      let status: RowTranslation["status"] = "invalid";
      let parserRows: AcceptedRow["parserRows"] = [];
      if (chosen?.ok) {
        const result = this.o.validate(joinCp([...this.accepted.map((a) => a.cp), cp]));
        if (result.ok) {
          parserRows = newParserRows(result, before);
          const check = parserRows.length ? lastRowCount(result) : undefined;
          status = !check || countMatches(check, row.statedCount) ? "valid" : "count_mismatch";
        }
      }
      this.translations[row.id] = {
        rowId: row.id,
        cp,
        source: "llm",
        status,
        confidence: "medium",
        assumptions: chosen?.assumptions ?? [],
        attempts: row === todo[0] ? attempts : [],
      };
      if (status !== "invalid") {
        this.accepted.push({ row, cp, parserRows });
        before = parserRows.at(-1) ? parserRows.at(-1)!.row + 1 : before;
      }
    }
  }

  private wholeCountMismatches(cps: Map<string, string>): string[] {
    const out: string[] = [];
    const parts: string[] = [];
    // Parser rows before the current row. Only rows with a stated count are
    // validated, so after unchecked rows with stitches it is recounted.
    let rowsBefore = 0;
    let stale = false;
    for (const row of this.input.rows) {
      const cp = this.input.given?.[row.id] ?? cps.get(row.id) ?? "";
      if (row.statedCount === undefined || this.input.given?.[row.id] !== undefined) {
        parts.push(cp);
        if (cp.trim()) stale = true;
        continue;
      }
      // A row that makes no stitches passes, as in row mode.
      if (!cp.trim()) continue;
      if (stale) {
        const before = this.o.validate(joinCp(parts));
        if (before.ok) rowsBefore = before.rows.length;
        stale = false;
      }
      parts.push(cp);
      const result = this.o.validate(joinCp(parts));
      if (!result.ok) continue;
      if (result.rows.length > rowsBefore) {
        const check = lastRowCount(result);
        if (!countMatches(check, row.statedCount)) {
          out.push(`[${row.id}] states ${row.statedCount}, the parser counts ${check?.parsed}`);
        }
      }
      rowsBefore = result.rows.length;
    }
    return out;
  }

  result(): TranslateResult {
    return {
      pattern: {
        english: this.input.english,
        rows: this.input.rows,
        translations: this.translations,
        answers: Object.fromEntries(this.context.answers.map((a) => [a.rowId, a.answer])),
        colors: this.context.colors,
        promptVersion: "",
        provider: this.o.model.provider,
        model: this.o.modelName,
      },
      usage: this.usage,
      requests: this.requests,
      models: [...this.models],
      ...(this.requests && this.cost !== undefined ? { costUsd: this.cost } : {}),
    };
  }
}

/** A repair or follow-up message. */
function userTurn(text: string): Turn {
  return { role: "user", blocks: [{ text, cache: false }] };
}

function safeJson<T>(text: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }):
  | { ok: true; value: T }
  | { ok: false; why: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, why: "it is not valid JSON" };
  }
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, why: `it does not match the schema (${r.error.message.slice(0, 200)})` };
}

/** Row mode: the app's loop. */
export async function translatePattern(input: TranslateInput, options: TranslateOptions): Promise<TranslateResult> {
  const t = new PatternTranslator(input, options);
  await t.translateRows();
  const result = t.result();
  result.pattern.promptVersion = promptVersion(settingsOf({ ...options, provider: options.model.provider }, "row"));
  return result;
}

/** Whole mode: one request for the whole pattern, for comparison with Dias & Karim. */
export async function translateWhole(input: TranslateInput, options: TranslateOptions): Promise<TranslateResult> {
  const t = new PatternTranslator(input, options);
  await t.translateWhole();
  const result = t.result();
  result.pattern.promptVersion = promptVersion(settingsOf({ ...options, provider: options.model.provider }, "whole"));
  return result;
}
