// App state (docs/SPEC.md §9). The pattern is saved to localStorage as a
// convenience; export is the durable format. A guest's API key lives in this
// store's memory only: never in localStorage or sessionStorage (§8.3).

import { segmentPattern, ukToUs, type RowTranslation, type SegmentedPattern } from "@crochet-model/core";
import { create } from "zustand";
import {
  api,
  ApiError,
  auth,
  describeError,
  translate,
  translateRow,
  type Done,
  type Effort,
  type ProviderId,
  type SavedKey,
  type SessionUser,
  type Settings,
  type TranslateMode,
} from "./api.ts";
import type { Translations } from "./pattern.ts";
import { SAMPLES } from "./samples.ts";

const PATTERN_KEY = "crochet-model:pattern";
const SETTINGS_KEY = "crochet-model:settings";
const CONFIRMED_KEY = "crochet-model:confirmed-providers";
const MODE_KEY = "crochet-model:translate-mode";

interface Saved {
  english: string;
  translations: Translations;
  colors: Record<string, string>;
  dismissed: Record<string, string[]>;
  sampleId?: string;
}

export interface State {
  english: string;
  segmented: SegmentedPattern;
  /** UK terms detected and the user said keep them as they are. */
  ukKept: boolean;
  translations: Translations;
  colors: Record<string, string>;
  /** Assumption notes the user dismissed, by row id (FR-3.4). */
  dismissed: Record<string, string[]>;
  sampleId?: string;

  /** Rows being translated now, by id. */
  busyRows: Record<string, true>;
  translating: boolean;
  /** How the running translation goes: whole-pattern rows all arrive at the end. */
  translatingMode?: TranslateMode;
  lastRun?: Done;
  error?: string;
  /** The row highlighted in the review and the model. */
  selectedRowId?: string;

  provider: ProviderId;
  model: string | null;
  effort: Effort;
  /** Kept in this browser only, for guests and signed-in users alike. */
  mode: TranslateMode;
  cacheEnabled: boolean;
  /** Guest keys by provider: memory only. */
  keys: Partial<Record<ProviderId, string>>;
  user?: SessionUser;
  savedKeys: SavedKey[];
  /** Providers the server has a development key for (.env.local). */
  serverKeys: ProviderId[];
  /** Providers the user agreed to send patterns to (NFR-3). */
  confirmedProviders: ProviderId[];
}

const read = <T,>(key: string): T | undefined => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the pattern still works, it just is not kept.
  }
};

const initialSample = SAMPLES.find((s) => s.id === "ball")!;
const saved = read<Saved>(PATTERN_KEY);
const guestSettings = read<Partial<Settings>>(SETTINGS_KEY);

function sampleTranslations(id: string): Translations {
  const sample = SAMPLES.find((s) => s.id === id)!;
  const { rows } = segmentPattern(sample.english);
  return Object.fromEntries(
    rows.map((row, i) => [
      row.id,
      { rowId: row.id, cp: sample.cp[i] ?? "", source: "gold", status: "valid", confidence: "high", assumptions: [], attempts: [] } satisfies RowTranslation,
    ]),
  );
}

const startEnglish = saved?.english ?? initialSample.english;

export const useApp = create<State>(() => ({
  english: startEnglish,
  segmented: segmentPattern(startEnglish),
  ukKept: false,
  translations: saved?.translations ?? sampleTranslations(initialSample.id),
  colors: saved?.colors ?? {},
  dismissed: saved?.dismissed ?? {},
  sampleId: saved ? saved.sampleId : initialSample.id,
  busyRows: {},
  translating: false,
  provider: guestSettings?.provider ?? "anthropic",
  model: guestSettings?.model ?? "claude-opus-5-5",
  effort: guestSettings?.effort ?? "medium",
  mode: read<TranslateMode>(MODE_KEY) === "document" ? "document" : "row",
  cacheEnabled: guestSettings?.cacheEnabled ?? true,
  keys: {},
  savedKeys: [],
  serverKeys: [],
  confirmedProviders: read<ProviderId[]>(CONFIRMED_KEY) ?? [],
}));

const set = useApp.setState;
const get = useApp.getState;

useApp.subscribe((s, prev) => {
  if (s.english !== prev.english || s.translations !== prev.translations || s.colors !== prev.colors || s.dismissed !== prev.dismissed) {
    write(PATTERN_KEY, { english: s.english, translations: s.translations, colors: s.colors, dismissed: s.dismissed, sampleId: s.sampleId } satisfies Saved);
  }
  if (!s.user && (s.provider !== prev.provider || s.model !== prev.model || s.effort !== prev.effort || s.cacheEnabled !== prev.cacheEnabled)) {
    write(SETTINGS_KEY, { provider: s.provider, model: s.model, effort: s.effort, cacheEnabled: s.cacheEnabled });
  }
  if (s.mode !== prev.mode) write(MODE_KEY, s.mode);
});

// --- Pattern ---------------------------------------------------------------------

export function setEnglish(english: string) {
  const segmented = segmentPattern(english);
  const ids = new Set(segmented.rows.map((r) => r.id));
  // Rows whose text is unchanged keep their translation (row ids hash the text).
  const translations = Object.fromEntries(Object.entries(get().translations).filter(([id]) => ids.has(id)));
  set({ english, segmented, translations, sampleId: undefined, ukKept: false, error: undefined });
}

export function loadSample(id: string) {
  const sample = SAMPLES.find((s) => s.id === id)!;
  set({
    english: sample.english,
    segmented: segmentPattern(sample.english),
    translations: sampleTranslations(id),
    colors: {},
    dismissed: {},
    sampleId: id,
    ukKept: false,
    error: undefined,
    lastRun: undefined,
    selectedRowId: undefined,
  });
}

export function convertUkTerms() {
  setEnglish(ukToUs(get().english));
}

export function keepUkTerms() {
  set({ ukKept: true });
}

export function selectRow(rowId: string | undefined) {
  set({ selectedRowId: rowId });
}

function upsert(t: RowTranslation) {
  set((s) => ({ translations: { ...s.translations, [t.rowId]: t } }));
}

/** The user's own CrochetPARADE for a row (FR-3.3); its status is set by the review's check. */
export function editRow(rowId: string, cp: string, status: RowTranslation["status"]) {
  const old = get().translations[rowId];
  upsert({
    rowId,
    cp,
    source: "user",
    status,
    confidence: "high",
    assumptions: old?.assumptions ?? [],
    question: old?.question,
    attempts: old?.attempts ?? [],
  });
}

export function dismissAssumption(rowId: string, text: string) {
  set((s) => ({ dismissed: { ...s.dismissed, [rowId]: [...(s.dismissed[rowId] ?? []), text] } }));
}

// --- Translation ---------------------------------------------------------------

function answers(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, t] of Object.entries(get().translations)) if (t.question?.answer !== undefined) out[id] = t.question.answer;
  return out;
}

function edits(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, t] of Object.entries(get().translations)) if (t.source === "user") out[id] = t.cp;
  return out;
}

function request() {
  const s = get();
  if (!s.model) throw new ApiError(400, "no_model");
  return { english: s.english, answers: answers(), colors: s.colors, provider: s.provider, model: s.model, effort: s.effort, cache: s.cacheEnabled, mode: s.mode };
}

let running: AbortController | undefined;

export function setMode(mode: TranslateMode) {
  set({ mode });
}

/** Translates every row that is not the user's own (FR-2.1, FR-3.3). */
export async function translateAll(): Promise<void> {
  const s = get();
  running?.abort();
  const controller = (running = new AbortController());
  const keep = Object.fromEntries(Object.entries(s.translations).filter(([, t]) => t.source === "user"));
  set({ translations: keep, translating: true, translatingMode: s.mode, error: undefined, lastRun: undefined, sampleId: undefined, busyRows: Object.fromEntries(s.segmented.rows.filter((r) => !keep[r.id]).map((r) => [r.id, true])) });
  try {
    await translate({ ...request(), edits: edits() }, s.keys[s.provider], {
      onRow: (t) => {
        upsert(t);
        set((st) => {
          const busyRows = { ...st.busyRows };
          delete busyRows[t.rowId];
          return { busyRows };
        });
      },
      onDone: (d) => set({ lastRun: d }),
    }, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) failed(error);
  } finally {
    if (running === controller) set({ translating: false, translatingMode: undefined, busyRows: {} });
  }
}

export function cancelTranslation() {
  running?.abort();
  set({ translating: false, translatingMode: undefined, busyRows: {} });
}

/** One row again: after an answer without code, or a rejected assumption (FR-2.6, FR-3.4). */
export async function retranslateRow(rowId: string, rejected: string[] = []): Promise<void> {
  const s = get();
  const index = s.segmented.rows.findIndex((r) => r.id === rowId);
  const before = Object.fromEntries(s.segmented.rows.slice(0, index).flatMap((r) => (s.translations[r.id] ? [[r.id, s.translations[r.id]!]] : [])));
  set((st) => ({ busyRows: { ...st.busyRows, [rowId]: true }, error: undefined }));
  try {
    await translateRow({ ...request(), mode: "row", rowId, translations: before, rejected }, s.keys[s.provider], {
      onRow: upsert,
      onDone: (d) => set({ lastRun: d }),
    });
  } catch (error) {
    failed(error);
  } finally {
    set((st) => {
      const busyRows = { ...st.busyRows };
      delete busyRows[rowId];
      return { busyRows };
    });
  }
}

export function rejectAssumption(rowId: string, text: string) {
  dismissAssumption(rowId, text);
  void retranslateRow(rowId, [text]);
}

/** The user picks an option (FR-2.6). An option with code is used as is; one without asks the model again. */
export function answerQuestion(rowId: string, option: number) {
  const t = get().translations[rowId];
  if (!t?.question) return;
  const chosen = t.question.options[option];
  const question = { ...t.question, answer: option };
  if (chosen?.cp != null) {
    // The review's check sets the final status once the new code is validated.
    upsert({ ...t, cp: chosen.cp, question, status: "valid" });
  } else {
    upsert({ ...t, question });
    void retranslateRow(rowId);
  }
}

function failed(error: unknown) {
  if (error instanceof ApiError && error.code === "key_rejected") {
    const p = error.provider ?? get().provider;
    set((s) => {
      const keys = { ...s.keys };
      delete keys[p];
      return { keys };
    });
    void refreshKeys();
  }
  set({ error: describeError(error) });
}

// --- Provider, model and keys ----------------------------------------------------

export function chooseProvider(provider: ProviderId) {
  set({ provider, model: provider === "anthropic" ? "claude-opus-5-5" : null });
}

export function setGuestKey(provider: ProviderId, key: string) {
  set((s) => ({ keys: { ...s.keys, [provider]: key.trim() || undefined } }));
}

export function confirmProvider(provider: ProviderId) {
  const confirmedProviders = [...new Set([...get().confirmedProviders, provider])];
  set({ confirmedProviders });
  write(CONFIRMED_KEY, confirmedProviders);
}

export function setTranslationSettings(s: Partial<Pick<State, "model" | "effort" | "cacheEnabled" | "provider">>) {
  set(s);
  const st = get();
  if (st.user) {
    void api.saveSettings({ provider: st.provider, model: st.model, effort: st.effort, cacheEnabled: st.cacheEnabled }).catch(() => {});
  }
}

// --- Session ---------------------------------------------------------------------

export async function refreshSession(): Promise<void> {
  try {
    const session = await auth.session();
    set({ user: session?.user ?? undefined });
    if (session?.user) {
      await refreshKeys();
      const settings = await api.settings();
      set((s) => ({
        provider: settings.provider ?? s.provider,
        model: settings.provider ? settings.model : s.model,
        effort: settings.effort ?? s.effort,
        cacheEnabled: settings.cacheEnabled,
      }));
    } else set({ savedKeys: [] });
  } catch {
    // The API server is not running: the app still works on samples and hand-written code.
    set({ user: undefined, savedKeys: [] });
  }
}

export async function refreshKeys(): Promise<void> {
  if (!get().user) return;
  try {
    const { keys } = await api.keys();
    set({ savedKeys: keys });
  } catch {
    set({ savedKeys: [] });
  }
}

export async function signOut(): Promise<void> {
  await auth.signOut().catch(() => {});
  set({ user: undefined, savedKeys: [] });
}

/** The saved key for the chosen provider, if usable. */
export function savedKeyFor(s: State, provider = s.provider): SavedKey | undefined {
  const k = s.savedKeys.find((k) => k.provider === provider);
  return k && k.status !== "invalid" ? k : undefined;
}

export function hasKey(s: State, provider = s.provider): boolean {
  return !!s.keys[provider] || !!savedKeyFor(s, provider) || s.serverKeys.includes(provider);
}

/** Which providers the server has a development key for. */
export async function refreshServerKeys(): Promise<void> {
  try {
    set({ serverKeys: (await api.health()).serverKeys ?? [] });
  } catch {
    set({ serverKeys: [] });
  }
}
