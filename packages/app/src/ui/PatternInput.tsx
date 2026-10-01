// The Pattern screen (docs/SPEC.md §9): paste or pick a sample, confirm UK
// terms, choose provider, key and model, then translate.

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, describeError, KEY_PAGES, PROVIDER_NAMES, type Effort, type OfferedModel, type ProviderId } from "../api.ts";
import { SAMPLES } from "../samples.ts";
import {
  chooseProvider,
  confirmProvider,
  convertUkTerms,
  hasKey,
  keepUkTerms,
  loadSample,
  refreshKeys,
  savedKeyFor,
  setEnglish,
  setGuestKey,
  setTranslationSettings,
  translateAll,
  useApp,
} from "../store.ts";
import { Dialog } from "./Dialog.tsx";

const PROVIDERS: ProviderId[] = ["anthropic", "openrouter", "gemini", "openai"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Estimated above this, a translation asks first (SPEC §8.4). */
const CONFIRM_ABOVE_USD = 1;
const FREE_ONLY_KEY = "crochet-model:openrouter-free-only";

function readFreeOnly(): boolean {
  try {
    return localStorage.getItem(FREE_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function PatternInput({ onSignIn, onReview }: { onSignIn: () => void; onReview: () => void }) {
  const english = useApp((s) => s.english);
  const segmented = useApp((s) => s.segmented);
  const ukKept = useApp((s) => s.ukKept);
  const sampleId = useApp((s) => s.sampleId);
  const translating = useApp((s) => s.translating);
  const error = useApp((s) => s.error);
  const state = useApp();
  const keyReady = hasKey(state);
  const [estimate, setEstimate] = useState<{ dollars: number | null; requests: number }>();
  const [confirm, setConfirm] = useState<"privacy" | "cost" | undefined>();
  const [models, setModels] = useState<OfferedModel[]>([]);

  const price = models.find((m) => m.id === state.model)?.price ?? null;
  const rows = segmented.rows.length;

  useEffect(() => {
    if (!state.model || rows === 0) return setEstimate(undefined);
    const timer = setTimeout(() => {
      api
        .estimate({ english, provider: state.provider, model: state.model!, effort: state.effort, price })
        .then((e) => setEstimate(e))
        .catch(() => setEstimate(undefined));
    }, 400);
    return () => clearTimeout(timer);
  }, [english, state.provider, state.model, state.effort, price, rows]);

  const go = (checked: { privacy?: boolean; cost?: boolean } = {}) => {
    if (!checked.privacy && !state.confirmedProviders.includes(state.provider)) return setConfirm("privacy");
    if (!checked.cost && estimate?.dollars != null && estimate.dollars > CONFIRM_ABOVE_USD) return setConfirm("cost");
    setConfirm(undefined);
    void translateAll();
    onReview();
  };

  const ukPending = segmented.ukTerms && !ukKept;
  // Models are listed only for a key the provider accepted.
  const canTranslate = keyReady && models.length > 0 && !!state.model && rows > 0 && !translating && !ukPending;

  return (
    <div className="pane pattern-pane">
      <div className="samples" role="group" aria-label="Sample patterns">
        <span className="eyebrow">Samples, no key needed</span>
        <div className="sample-list">
          {SAMPLES.map((s) => (
            <button key={s.id} className={s.id === sampleId ? "sample active" : "sample"} onClick={() => (loadSample(s.id), onReview())}>
              <strong>{s.name}</strong>
              <span>{s.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="eyebrow">Your pattern, in US terms</span>
        <textarea
          className="english"
          value={english}
          spellCheck={false}
          onChange={(e) => setEnglish(e.target.value)}
          placeholder={"Rnd 1: 6 sc in magic ring. (6)\nRnd 2: 2 sc in each st around. (12)"}
          rows={12}
        />
      </label>
      <p className="hint">
        {rows} {rows === 1 ? "row" : "rows"} found
        {segmented.notes.length ? `, ${segmented.notes.length} ${segmented.notes.length === 1 ? "note" : "notes"} kept aside` : ""}. Rows start with a label such
        as “Rnd 3:” or “Row 2”. Counts at the end, like “(18)”, are checked.
      </p>

      {ukPending && (
        <div className="callout warn" role="alert">
          <p>
            <strong>This looks like UK terms.</strong> In UK patterns “dc” is the US single crochet and “tr” the US double crochet. Convert to US terms
            before translating?
          </p>
          <div className="row-actions">
            <button className="button small" onClick={convertUkTerms}>
              Convert to US terms
            </button>
            <button className="link" onClick={keepUkTerms}>
              It is already US terms
            </button>
          </div>
        </div>
      )}

      <ModelPicker models={models} setModels={setModels} onSignIn={onSignIn} />

      <div className="translate-bar">
        <button className="button primary" disabled={!canTranslate} onClick={() => go()}>
          {translating ? "Translating…" : sampleId ? "Translate it yourself" : "Translate"}
        </button>
        <span className="hint">
          {!keyReady
            ? `Enter an API key for ${PROVIDER_NAMES[state.provider]} to translate.`
            : models.length === 0
              ? ""
              : !state.model
              ? "Choose a model."
              : estimate
                ? estimate.dollars == null
                  ? `About ${estimate.requests} requests; no price on file for this model.`
                  : `Estimated up to US$${estimate.dollars.toFixed(2)} on your ${PROVIDER_NAMES[state.provider]} account, about ${estimate.requests} requests.`
                : ""}
        </span>
      </div>
      {error && (
        <p className="callout bad" role="alert">
          {error}
        </p>
      )}

      <Dialog open={confirm === "privacy"} onClose={() => setConfirm(undefined)} title={`Send this pattern to ${PROVIDER_NAMES[state.provider]}?`}>
        <p>
          Translating sends your pattern text to {PROVIDER_NAMES[state.provider]}
          {state.provider === "openrouter" ? ", and through OpenRouter to the company hosting the model you chose" : ""}, using your key. The cost goes to your
          account with them. Layout and rendering stay in your browser.
        </p>
        <p className="hint">
          {state.cacheEnabled
            ? "Translations are cached on our server so the same pattern costs nothing next time. You can turn the cache off in Settings."
            : "The translation cache is off: nothing about this pattern is kept on our server."}
        </p>
        <div className="dialog-actions">
          <button className="link" onClick={() => setConfirm(undefined)}>
            Cancel
          </button>
          <button className="button primary" onClick={() => (confirmProvider(state.provider), go({ privacy: true }))}>
            Send and translate
          </button>
        </div>
      </Dialog>
      <Dialog open={confirm === "cost"} onClose={() => setConfirm(undefined)} title="This pattern may be costly">
        <p>
          The estimate is up to US${estimate?.dollars?.toFixed(2)} on your {PROVIDER_NAMES[state.provider]} account. A lower effort or a smaller model costs
          less.
        </p>
        <div className="dialog-actions">
          <button className="link" onClick={() => setConfirm(undefined)}>
            Cancel
          </button>
          <button className="button primary" onClick={() => go({ privacy: true, cost: true })}>
            Translate anyway
          </button>
        </div>
      </Dialog>
    </div>
  );
}

/** Provider, key and model (docs/SPEC.md §9). Translate is disabled until there is a key. */
function ModelPicker({ models, setModels, onSignIn }: { models: OfferedModel[]; setModels: (m: OfferedModel[]) => void; onSignIn: () => void }) {
  const s = useApp();
  const provider = s.provider;
  const guestKey = s.keys[provider] ?? "";
  const saved = savedKeyFor(s);
  const [draft, setDraft] = useState(guestKey);
  const [status, setStatus] = useState<{ kind: "idle" | "checking" | "ok" | "bad"; text?: string }>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const fromServer = s.serverKeys.includes(provider);
  // The same order the server uses: typed, then saved, then .env.local.
  const keySource = guestKey ? "guest" : saved ? "saved" : fromServer ? "server" : undefined;
  // OpenRouter lists hundreds of models; this narrows them to the free ones.
  const [freeOnlyChoice, setFreeOnlyChoice] = useState(readFreeOnly);
  const freeOnly = provider === "openrouter" && freeOnlyChoice;
  const shown = useMemo(() => (freeOnly ? models.filter((m) => m.free) : models), [models, freeOnly]);
  const toggleFreeOnly = (on: boolean) => {
    setFreeOnlyChoice(on);
    try {
      localStorage.setItem(FREE_ONLY_KEY, on ? "1" : "0");
    } catch {
      // Not remembered; the filter still works for this visit.
    }
  };

  // Keep the chosen model among the ones shown.
  useEffect(() => {
    if (shown.length && !shown.some((m) => m.id === s.model)) setTranslationSettings({ model: shown[0]!.id });
  }, [shown, s.model]);

  useEffect(() => setDraft(s.keys[provider] ?? ""), [provider, s.keys]);

  // List models once there is a key: this also checks the key (FR-7.3).
  useEffect(() => {
    if (!keySource) {
      setModels([]);
      setStatus({ kind: "idle" });
      return;
    }
    let live = true;
    setStatus({ kind: "checking" });
    api
      .models(provider, guestKey || undefined)
      .then(({ models, default: def }) => {
        if (!live) return;
        setModels(models);
        setStatus({ kind: "ok" });
        const current = useApp.getState().model;
        if (!current || !models.some((m) => m.id === current)) setTranslationSettings({ model: def ?? models[0]?.id ?? null });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setModels([]);
        setStatus({ kind: "bad", text: describeError(e) });
        if (e instanceof ApiError && e.code === "key_rejected" && keySource === "saved") void refreshKeys();
      });
    return () => {
      live = false;
    };
  }, [provider, guestKey, keySource, setModels]);

  const recommended = shown.filter((m) => m.recommended);
  const others = useMemo(() => shown.filter((m) => !m.recommended), [shown]);
  const optionLabel = (m: OfferedModel) => (m.free && !freeOnly ? `${m.id} · free` : m.id);
  const chosen = models.find((m) => m.id === s.model);

  const saveToAccount = async () => {
    setSaving(true);
    try {
      await api.saveKey(provider, guestKey);
      setGuestKey(provider, "");
      await refreshKeys();
    } catch (e) {
      setStatus({ kind: "bad", text: describeError(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="picker">
      <legend className="eyebrow">Model</legend>
      <div className="picker-grid">
        <label className="field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => chooseProvider(e.target.value as ProviderId)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="field key-field">
          <span>
            API key{" "}
            <a href={KEY_PAGES[provider]} target="_blank" rel="noreferrer noopener">
              get one
            </a>
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={saved ? `saved key ••••${saved.last4}` : fromServer ? "using the key in .env.local" : "paste your key"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setGuestKey(provider, draft)}
            onKeyDown={(e) => e.key === "Enter" && setGuestKey(provider, draft)}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <select value={s.model ?? ""} disabled={shown.length === 0} onChange={(e) => setTranslationSettings({ model: e.target.value })}>
            {shown.length === 0 && <option value="">{models.length && freeOnly ? "no free model" : (s.model ?? "—")}</option>}
            {recommended.length > 0 && (
              <optgroup label="Recommended">
                {recommended.map((m) => (
                  <option key={m.id} value={m.id}>
                    {optionLabel(m)}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Not evaluated">
                {others.map((m) => (
                  <option key={m.id} value={m.id}>
                    {optionLabel(m)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="field">
          <span>Effort</span>
          <select value={s.effort} onChange={(e) => setTranslationSettings({ effort: e.target.value as Effort })}>
            {EFFORTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </label>
      </div>

      <p className={`key-status ${status.kind}`} aria-live="polite">
        {status.kind === "checking" && "Checking the key…"}
        {status.kind === "ok" &&
          (keySource === "saved"
            ? `Using your saved key ••••${saved!.last4}.`
            : keySource === "server"
              ? "Using the development key from .env.local on the server. Paste a key to use another."
              : "Key accepted. Kept in this tab only, forgotten on reload.")}
        {status.kind === "bad" && status.text}
        {status.kind === "idle" && "Your key goes to our server with each request and is never stored, unless you save it to an account."}
      </p>
      {provider === "openrouter" && (
        <label className="check free-only">
          <input type="checkbox" checked={freeOnlyChoice} onChange={(e) => toggleFreeOnly(e.target.checked)} />
          <span>
            Free models only
            <small>
              {models.length === 0
                ? "OpenRouter's free models, once the key is checked."
                : `${models.filter((m) => m.free).length} of ${models.length} models are free. Free models are rate limited and may log prompts.`}
            </small>
          </span>
        </label>
      )}
      {freeOnly && models.length > 0 && shown.length === 0 && (
        <p className="hint warn-text">None of OpenRouter’s free models can return structured output right now, so none can translate.</p>
      )}
      {chosen && !chosen.recommended && (
        <p className="hint warn-text">This model has not been evaluated with this app. Translations may be less accurate.</p>
      )}
      {guestKey && status.kind === "ok" && !saved && (
        <p className="hint">
          {s.user ? (
            <button className="link" disabled={saving} onClick={() => void saveToAccount()}>
              {saving ? "Saving…" : "Save this key to my account"}
            </button>
          ) : (
            <>
              <button className="link" onClick={onSignIn}>
                Sign in to save this key
              </button>{" "}
              and skip this step next time.
            </>
          )}
        </p>
      )}
    </fieldset>
  );
}
