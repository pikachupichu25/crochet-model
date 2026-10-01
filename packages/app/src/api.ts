// The server's API (docs/SPEC.md §8.1). A guest's key travels in
// `X-Provider-Key` on each request and is never stored by the browser or the
// server (§8.3).

import type { RowTranslation, Usage } from "@crochet-model/core";

export type ProviderId = "anthropic" | "openrouter" | "gemini" | "openai";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  openai: "OpenAI",
};

export const KEY_PAGES: Record<ProviderId, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openrouter: "https://openrouter.ai/settings/keys",
  gemini: "https://aistudio.google.com/app/apikey",
  openai: "https://platform.openai.com/api-keys",
};

export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface OfferedModel {
  id: string;
  price: Price | null;
  recommended: boolean;
  evaluated: boolean;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface SavedKey {
  provider: ProviderId;
  last4: string;
  status: "ok" | "invalid" | "unchecked";
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Settings {
  provider: ProviderId | null;
  model: string | null;
  effort: Effort | null;
  cacheEnabled: boolean;
}

export interface Done {
  provider: ProviderId;
  model: string;
  promptVersion: string;
  usage: Usage;
  requests: number;
  costUsd: number | null;
}

/** An error the server named: `no_key`, `key_rejected`, `no_credit`, `busy`, … */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly provider?: ProviderId;
  constructor(status: number, code: string, message?: string, provider?: ProviderId) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.provider = provider;
  }
}

async function call<T>(path: string, init: RequestInit & { key?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (init.key) headers.set("x-provider-key", init.key);
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string; message?: string; provider?: ProviderId };
    throw new ApiError(res.status, b.error ?? b.code ?? httpCode(res.status), b.message, b.provider);
  }
  return body as T;
}

/**
 * A status with no error body. The dev server's proxy answers 502 or 504 by
 * itself when the API server is not running.
 */
function httpCode(status: number): string {
  return status === 502 || status === 503 || status === 504 ? "server_unreachable" : `http_${status}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const json = (body: unknown) => JSON.stringify(body);

// --- Accounts (Better Auth's routes) --------------------------------------------

export const auth = {
  session: () => call<{ user: SessionUser } | null>("/api/auth/get-session"),
  signUp: (email: string, password: string) =>
    call("/api/auth/sign-up/email", { method: "POST", body: json({ email, password, name: email.split("@")[0], callbackURL: "/?verified=1" }) }),
  signIn: (email: string, password: string) => call("/api/auth/sign-in/email", { method: "POST", body: json({ email, password }) }),
  signOut: () => call("/api/auth/sign-out", { method: "POST", body: json({}) }),
  resendVerification: (email: string) =>
    call("/api/auth/send-verification-email", { method: "POST", body: json({ email, callbackURL: "/?verified=1" }) }),
  requestReset: (email: string) =>
    call("/api/auth/request-password-reset", { method: "POST", body: json({ email, redirectTo: `${location.origin}/?reset=1` }) }),
  resetPassword: (token: string, newPassword: string) =>
    call("/api/auth/reset-password", { method: "POST", body: json({ token, newPassword }) }),
};

// --- Keys, models and settings ------------------------------------------------

export const api = {
  models: (provider: ProviderId, key?: string) =>
    call<{ models: OfferedModel[]; default: string | null }>(`/api/models/${provider}`, { key }),
  keys: () => call<{ keys: SavedKey[]; emailVerified: boolean }>("/api/keys"),
  saveKey: (provider: ProviderId, key: string) =>
    call<{ provider: ProviderId; last4: string; status: SavedKey["status"] }>(`/api/keys/${provider}`, { method: "PUT", body: json({ key }) }),
  deleteKey: (provider: ProviderId) => call(`/api/keys/${provider}`, { method: "DELETE" }),
  settings: () => call<Settings>("/api/settings"),
  saveSettings: (s: Settings) => call<Settings>("/api/settings", { method: "PUT", body: json(s) }),
  deleteAccount: () => call("/api/account", { method: "DELETE" }),
  estimate: (body: TranslateRequest & { price?: Price | null }) =>
    call<{ rows: number; requests: number; dollars: number | null }>("/api/translate/estimate", { method: "POST", body: json(body) }),
};

// --- Translation ---------------------------------------------------------------

export interface TranslateRequest {
  english: string;
  answers?: Record<string, number>;
  colors?: Record<string, string>;
  edits?: Record<string, string>;
  provider: ProviderId;
  model: string;
  effort?: Effort;
  cache?: boolean;
}

export interface TranslateRowRequest extends TranslateRequest {
  rowId: string;
  translations: Record<string, RowTranslation>;
  rejected?: string[];
}

export interface StreamHandlers {
  onRow(t: RowTranslation): void;
  onDone(d: Done): void;
}

/** Streams a translation: rows as they settle, then the totals. Rejects on errors. */
export function translate(body: TranslateRequest, key: string | undefined, handlers: StreamHandlers, signal?: AbortSignal) {
  return stream("/api/translate", body, key, handlers, signal);
}

export function translateRow(body: TranslateRowRequest, key: string | undefined, handlers: StreamHandlers, signal?: AbortSignal) {
  // Attempts are the server's record, not needed to re-translate.
  const translations = Object.fromEntries(Object.entries(body.translations).map(([id, t]) => [id, { ...t, attempts: [] }]));
  return stream("/api/translate/row", { ...body, translations }, key, handlers, signal);
}

async function stream(path: string, body: object, key: string | undefined, handlers: StreamHandlers, signal?: AbortSignal): Promise<void> {
  const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
  if (key) headers.set("x-provider-key", key);
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), signal, credentials: "same-origin" });
  if (!res.ok || !res.body) {
    const b = (safeJson(await res.text()) ?? {}) as { error?: string; message?: string; provider?: ProviderId };
    throw new ApiError(res.status, b.error ?? httpCode(res.status), b.message, b.provider);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1] ?? "message";
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "row") handlers.onRow(payload as RowTranslation);
      else if (event === "done") handlers.onDone(payload as Done);
      else if (event === "error") {
        const e = payload as { error: string; message?: string; provider?: ProviderId };
        throw new ApiError(502, e.error, e.message, e.provider);
      }
    }
  }
}

/** A sentence for the user, for an error code from the server. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  const who = error.provider ? PROVIDER_NAMES[error.provider] : "The provider";
  switch (error.code) {
    case "no_key":
      return `Enter an API key for ${who} first.`;
    case "key_rejected":
      return `${who} rejected the key. Check it, or enter a new one.`;
    case "no_credit":
      return `Your ${who} account is out of credit.`;
    case "bad_model":
      return `${who} does not know that model. Choose another.`;
    case "bad_request":
      return "The request was malformed. This is a bug; please report it.";
    case "busy":
      return "Two translations are already running. Wait for one to finish.";
    case "rate_limited":
      return "Too many translations in the last few minutes. Try again shortly.";
    case "too_many_rows":
      return "The pattern has more than 300 rows. Translate it in parts.";
    case "email_not_verified":
      return "Confirm your email address before saving a key. Check your inbox.";
    case "unauthenticated":
      return "Sign in first.";
    case "server_unreachable":
      return "The app's server is not responding. In development, start it with `npm run server`.";
    case "retryable":
      return `${who} could not be reached, or is overloaded. Try again.`;
    default:
      return error.message || error.code;
  }
}
