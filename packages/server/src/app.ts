// The HTTP API (docs/SPEC.md §8.1). Every step works without an account: a
// guest sends their provider key with each request in `X-Provider-Key`, and
// it is used for that request only. Signing in adds saved keys and settings.

import { readFileSync } from "node:fs";
import { segmentPattern, type PatternRow, type RowTranslation, type ValidationResult } from "@crochet-model/core";
import { VENDOR_DIR, createNodeValidator } from "@crochet-model/core/node";
import {
  costOf,
  createModel,
  DEFAULT_MODELS,
  estimatePattern,
  listModels,
  ModelError,
  priceOf,
  promptVersion,
  PROVIDERS,
  settingsOf,
  translatePattern,
  type AppProviderId,
  type Effort,
  type ModelInfo,
  type RowCache,
  type TranslatorModel,
} from "@crochet-model/translator";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Auth } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { last4, redact, scrub } from "./keys.ts";
import { TranslationLimits } from "./limits.ts";
import type { Store } from "./store.ts";

export interface Providers {
  createModel(provider: AppProviderId, options: { apiKey: string }): TranslatorModel;
  listModels(provider: AppProviderId, options: { apiKey: string }): Promise<ModelInfo[]>;
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export interface AppDeps {
  config: Pick<ServerConfig, "appOrigin" | "keyRing" | "maxConcurrent" | "maxPerWindow" | "maxRows">;
  auth: Auth;
  store: Store;
  log: Logger;
  /** The real provider adapters unless a test swaps them. */
  providers?: Providers;
  validate?: (text: string) => ValidationResult;
  /** The caller's address, for guest limits; the socket's by default. */
  clientIp?: (c: Context) => string;
}

const realProviders: Providers = {
  createModel: (provider, options) => createModel(provider, { ...options, fallbacks: true }),
  listModels,
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const Provider = z.enum(PROVIDERS as [AppProviderId, ...AppProviderId[]]);

const TranslateBody = z.object({
  english: z.string().min(1).max(200_000),
  answers: z.record(z.string(), z.number().int().min(0)).default({}),
  colors: z.record(z.string(), z.string()).default({}),
  /** The user's own CrochetPARADE, by row id (FR-3.3). */
  edits: z.record(z.string(), z.string()).default({}),
  provider: Provider.optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  /** A guest's cache setting; signed-in users' comes from their settings. */
  cache: z.boolean().optional(),
});

const RowTranslationBody = z.object({
  rowId: z.string(),
  cp: z.string(),
  source: z.enum(["llm", "rules", "user", "gold"]),
  status: z.enum(["valid", "count_mismatch", "invalid", "needs_answer"]),
  confidence: z.enum(["high", "medium", "low"]),
  assumptions: z.array(z.string()),
  question: z
    .object({
      text: z.string(),
      options: z.array(z.object({ label: z.string(), cp: z.string().nullable() })),
      answer: z.number().int().optional(),
    })
    .optional(),
});

const TranslateRowBody = TranslateBody.extend({
  rowId: z.string(),
  /** The settled rows before it, as the app shows them. */
  translations: z.record(z.string(), RowTranslationBody).default({}),
  /** Assumptions of this row the user rejected (FR-3.4). */
  rejected: z.array(z.string()).default([]),
});

const SettingsBody = z.object({
  provider: Provider.nullable(),
  model: z.string().max(200).nullable(),
  effort: z.enum(EFFORTS).nullable(),
  cacheEnabled: z.boolean(),
});

type SessionUser = { id: string; email: string; emailVerified: boolean };

/** A key in use for one request: from the header or decrypted from the store. */
interface KeyInUse {
  key: string;
  saved: boolean;
}

const MODEL_LIST_TTL_MS = 60 * 60_000;
const VENDOR_COMMIT = readFileSync(`${VENDOR_DIR}/COMMIT`, "utf8").trim();

export function createApp(deps: AppDeps) {
  const { config, auth, store, log } = deps;
  const providers = deps.providers ?? realProviders;
  const validate = deps.validate ?? createNodeValidator().validate;
  const limits = new TranslationLimits(config.maxConcurrent, config.maxPerWindow);
  const modelLists = new Map<string, { at: number; models: ModelInfo[] }>();
  const clientIp =
    deps.clientIp ??
    ((c: Context) => {
      try {
        return getConnInfo(c).remote.address ?? "unknown";
      } catch {
        return "unknown";
      }
    });

  const app = new Hono<{ Variables: { user: SessionUser | undefined } }>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    // Method, path and status only: never headers, bodies or query strings.
    log("request", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  // CSRF guard (§8.2): a request that changes state must come from the app.
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== config.appOrigin) {
      return c.json({ error: "bad_origin" }, 403);
    }
    await next();
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/api/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", session?.user as SessionUser | undefined);
    await next();
  });

  const requireUser = (c: Context<{ Variables: { user: SessionUser | undefined } }>) => c.get("user");

  /** The key for this request (§8): the header first, then the user's saved key. */
  const keyFor = (c: Context<{ Variables: { user: SessionUser | undefined } }>, provider: AppProviderId): KeyInUse | undefined => {
    const header = c.req.header("x-provider-key")?.trim();
    if (header) return { key: header, saved: false };
    const user = c.get("user");
    if (!user) return undefined;
    const row = store.getKey(user.id, provider);
    if (!row || row.status === "invalid") return undefined;
    try {
      return { key: config.keyRing.open(row, user.id, provider), saved: true };
    } catch {
      log("key_decrypt_failed", { provider });
      return undefined;
    }
  };

  /** A provider error as the app sees it, with the key scrubbed from the message. */
  const failure = (c: Context<{ Variables: { user: SessionUser | undefined } }>, provider: AppProviderId, key: KeyInUse, error: unknown) => {
    const kind = error instanceof ModelError ? error.kind : "retryable";
    const user = c.get("user");
    if (kind === "key_rejected" && key.saved && user) store.setKeyStatus(user.id, provider, "invalid");
    const message = scrub(error instanceof Error ? error.message : String(error), [key.key]);
    log("provider_error", { provider, kind, message });
    return { error: kind, provider, message };
  };

  app.get("/api/health", (c) =>
    c.json({
      promptVersion: promptVersion(settingsOf({ provider: "anthropic", modelName: DEFAULT_MODELS.anthropic!, effort: "medium", repairEffort: "high" }, "row")),
      crochetparade: VENDOR_COMMIT,
      providers: PROVIDERS,
      defaults: DEFAULT_MODELS,
    }),
  );

  // --- Models -----------------------------------------------------------------

  app.get("/api/models/:provider", async (c) => {
    const parsed = Provider.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "unknown_provider" }, 404);
    const provider = parsed.data;
    const key = keyFor(c, provider);
    if (!key) return c.json({ error: "no_key", provider }, 409);
    const user = c.get("user");
    const cacheKey = key.saved && user ? `${user.id}:${provider}` : undefined;
    const cached = cacheKey ? modelLists.get(cacheKey) : undefined;
    let models: ModelInfo[];
    if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) models = cached.models;
    else {
      try {
        models = await providers.listModels(provider, { apiKey: key.key });
      } catch (error) {
        const body = failure(c, provider, key, error);
        return c.json(body, body.error === "key_rejected" ? 401 : 502);
      }
      if (cacheKey) modelLists.set(cacheKey, { at: Date.now(), models });
    }
    if (key.saved && user) store.setKeyStatus(user.id, provider, "ok");
    const defaultModel = DEFAULT_MODELS[provider];
    // No model has been scored yet (models.json waits on the sweep, §5.6), so
    // every model is "not evaluated"; the default comes first.
    const offered = models
      .filter((m) => m.structuredOutput)
      .map((m) => ({
        id: m.id,
        price: priceOf(provider, m.id, m.price) ?? null,
        recommended: m.id === defaultModel,
        evaluated: false,
      }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.id.localeCompare(b.id));
    return c.json({ provider, models: offered, default: defaultModel ?? null });
  });

  // --- Saved keys (signed in) -------------------------------------------------

  app.get("/api/keys", (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ keys: store.listKeys(user.id), emailVerified: user.emailVerified });
  });

  app.put("/api/keys/:provider", async (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = Provider.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "unknown_provider" }, 404);
    if (!user.emailVerified) return c.json({ error: "email_not_verified" }, 403);
    const provider = parsed.data;
    const body = z.object({ key: z.string().trim().min(8).max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_key" }, 400);
    const key = body.data.key;
    // Checked with the provider before saving (§8.3): a rejected key is not saved.
    let status: "ok" | "unchecked" = "ok";
    try {
      await providers.listModels(provider, { apiKey: key });
    } catch (error) {
      const kind = error instanceof ModelError ? error.kind : "retryable";
      if (kind !== "retryable") {
        log("key_check_failed", { provider, kind });
        return c.json({ error: kind === "key_rejected" ? "key_rejected" : kind, provider }, 400);
      }
      status = "unchecked";
    }
    store.putKey(user.id, provider, config.keyRing.seal(key, user.id, provider), last4(key), status);
    modelLists.delete(`${user.id}:${provider}`);
    log("key_saved", { provider, status });
    return c.json({ provider, last4: last4(key), status });
  });

  app.delete("/api/keys/:provider", (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const provider = c.req.param("provider");
    const deleted = store.deleteKey(user.id, provider);
    modelLists.delete(`${user.id}:${provider}`);
    return c.json({ deleted });
  });

  // --- Settings (signed in; guests keep theirs in the browser) ----------------

  app.get("/api/settings", (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json(store.getSettings(user.id));
  });

  app.put("/api/settings", async (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const body = SettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_settings" }, 400);
    store.putSettings(user.id, body.data);
    return c.json(body.data);
  });

  app.delete("/api/account", async (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    store.deleteUser(user.id);
    for (const provider of PROVIDERS) modelLists.delete(`${user.id}:${provider}`);
    log("account_deleted");
    // The session row is gone; clear the cookie too.
    const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true }).catch(() => undefined);
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of res?.headers.getSetCookie() ?? []) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ deleted: true }), { status: 200, headers });
  });

  // --- Translation --------------------------------------------------------------

  /** Provider, model, effort and cache from the body, else the user's settings. */
  const choices = (c: Context<{ Variables: { user: SessionUser | undefined } }>, body: z.infer<typeof TranslateBody>) => {
    const user = c.get("user");
    const settings = user ? store.getSettings(user.id) : undefined;
    const provider = (body.provider ?? settings?.provider ?? "anthropic") as AppProviderId;
    const model = body.model ?? (settings?.provider === provider ? settings.model : null) ?? DEFAULT_MODELS[provider];
    const effort = (body.effort ?? settings?.effort ?? "medium") as Effort;
    const cache = user ? settings!.cacheEnabled && body.cache !== false : body.cache !== false;
    return { provider, model, effort, cache };
  };

  app.post("/api/translate/estimate", async (c) => {
    const body = TranslateBody.extend({
      price: z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }).nullable().optional(),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const { provider, model, effort } = choices(c, body.data);
    if (!model) return c.json({ error: "no_model", provider }, 400);
    const rows = segmentPattern(body.data.english).rows.length;
    const estimate = estimatePattern(body.data.english, rows, effort, priceOf(provider, model, body.data.price ?? undefined));
    return c.json({ provider, model, rows, requests: estimate.requests, dollars: estimate.dollars ?? null });
  });

  /**
   * Runs the loop and streams each settled row as a server-sent event
   * (NFR-1), then `done` with usage and cost, or `error`.
   */
  const translate = async (
    c: Context<{ Variables: { user: SessionUser | undefined } }>,
    body: z.infer<typeof TranslateBody>,
    extra: { fixed: Record<string, RowTranslation>; only?: string[]; rejected?: Record<string, string[]>; readCache: boolean },
  ) => {
    const { provider, model, effort, cache } = choices(c, body);
    if (!model) return c.json({ error: "no_model", provider }, 400);
    const key = keyFor(c, provider);
    if (!key) return c.json({ error: "no_key", provider }, 409);
    const segmented = segmentPattern(body.english);
    if (segmented.rows.length === 0) return c.json({ error: "no_rows" }, 400);
    if (segmented.rows.length > config.maxRows) return c.json({ error: "too_many_rows", max: config.maxRows }, 413);
    const user = c.get("user");
    const who = user ? `user:${user.id}` : `ip:${clientIp(c)}`;
    const slot = limits.acquire(who);
    if ("refused" in slot) return c.json({ error: slot.refused }, 429);

    const fixed = { ...extra.fixed };
    for (const row of segmented.rows) {
      const cp = body.edits[row.id];
      if (cp !== undefined) fixed[row.id] = userRow(row, cp);
    }
    const shared = cache ? store.rowCache() : undefined;
    const rowCache: RowCache | undefined = shared && {
      get: (k) => (extra.readCache ? shared.get(k) : undefined),
      set: shared.set,
    };
    if (key.saved && user) store.touchKey(user.id, provider);

    return streamSSE(c, async (stream) => {
      const aborted = new AbortController();
      stream.onAbort(() => aborted.abort());
      try {
        const result = await translatePattern(
          { english: body.english, rows: segmented.rows, notes: segmented.notes, colors: body.colors, fixed, rejected: extra.rejected },
          {
            model: providers.createModel(provider, { apiKey: key.key }),
            modelName: model,
            effort,
            repairEffort: effort === "low" || effort === "medium" ? "high" : effort,
            validate,
            idPrefix: "app",
            answer: ({ row }) => body.answers[row.id],
            onRow: (t) => void stream.writeSSE({ event: "row", data: JSON.stringify(t) }),
            only: extra.only,
            cache: rowCache,
            signal: aborted.signal,
          },
        );
        const price = priceOf(provider, model);
        const costUsd = result.costUsd ?? costOf(price, result.usage, false);
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            provider,
            model,
            promptVersion: result.pattern.promptVersion,
            usage: result.usage,
            requests: result.requests,
            costUsd: costUsd ?? null,
          }),
        });
      } catch (error) {
        if (aborted.signal.aborted) log("translation_cancelled", { provider });
        else await stream.writeSSE({ event: "error", data: JSON.stringify(failure(c, provider, key, error)) });
      } finally {
        slot.release();
      }
    });
  };

  app.post("/api/translate", async (c) => {
    const body = TranslateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues.map((i) => i.path.join(".")) }, 400);
    return translate(c, body.data, { fixed: {}, readCache: true });
  });

  // One row again: after an answer, a rejected assumption, or a fix to an
  // earlier row (§8.1). Earlier rows come as the app has them; later rows
  // are left alone. A fresh answer is wanted, so the cache is not read.
  app.post("/api/translate/row", async (c) => {
    const body = TranslateRowBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues.map((i) => i.path.join(".")) }, 400);
    const rows = segmentPattern(body.data.english).rows;
    const target = rows.findIndex((r) => r.id === body.data.rowId);
    if (target < 0) return c.json({ error: "unknown_row" }, 400);
    const fixed: Record<string, RowTranslation> = {};
    for (const row of rows.slice(0, target)) {
      const t = body.data.translations[row.id];
      if (t) fixed[row.id] = { ...t, attempts: [] };
    }
    return translate(c, body.data, {
      fixed,
      only: [body.data.rowId],
      rejected: body.data.rejected.length ? { [body.data.rowId]: body.data.rejected } : undefined,
      readCache: false,
    });
  });

  app.onError((error, c) => {
    log("unhandled", { message: error.message, stack: error.stack?.split("\n").slice(0, 4).join(" | ") });
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

function userRow(row: PatternRow, cp: string): RowTranslation {
  // The loop checks it and sets the status (FR-3.3).
  return { rowId: row.id, cp, source: "user", status: "valid", confidence: "high", assumptions: [], attempts: [] };
}

/** JSON lines on stdout, with secret fields and headers redacted. */
export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  return (event, fields = {}) => write(JSON.stringify({ t: new Date().toISOString(), event, ...(redact(fields) as object) }));
}
