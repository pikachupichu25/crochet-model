import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { ModelError, type ModelReply, type ModelRequest, type TranslatorModel } from "@crochet-model/translator";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, jsonLogger, type Providers } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { KeyRing, parseMasterKeys, redact, scrub } from "../src/keys.ts";
import { TranslationLimits } from "../src/limits.ts";
import { ConsoleMailer } from "../src/mail.ts";
import { Store } from "../src/store.ts";

const ORIGIN = "http://localhost:5180";
const GOOD_KEY = "sk-test-planted-key-0123456789abcdef";
const OTHER_KEY = "sk-test-other-user-key-fedcba9876543210";
/** Lists models but is refused when translating. */
const REVOKED_KEY = "sk-revoked-key-0011223344556677";

const rowReply = (cp: string): ModelReply => {
  const text = JSON.stringify({ cp, expectedCount: null, confidence: "high", assumptions: [], question: null, amendPrevious: [] });
  return { text, raw: [{ type: "text", text }], stopReason: "end", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "fake-model" };
};

/** Answers every row with `6sc`-style rows; rejects keys that start with "bad". */
function fakeProviders(seen: { keys: string[]; requests: ModelRequest[] }): Providers {
  return {
    createModel(provider, { apiKey }): TranslatorModel {
      seen.keys.push(apiKey);
      return {
        provider,
        async send(request) {
          seen.requests.push(request);
          if (apiKey.startsWith("bad") || apiKey === REVOKED_KEY) throw new ModelError(provider, "key_rejected", `invalid x-api-key ${apiKey}`);
          return rowReply(request.messages.length === 1 && seen.requests.length % 2 === 1 ? "ring\n6sc" : "6*[sc2inc]");
        },
      };
    },
    async listModels(provider, { apiKey }) {
      seen.keys.push(apiKey);
      if (apiKey.startsWith("bad")) throw new ModelError(provider, "key_rejected", `Incorrect API key provided: ${apiKey.slice(0, 3)}***${apiKey.slice(-4)}`);
      return [
        { id: "fake-model", structuredOutput: true },
        { id: "claude-opus-5-5", structuredOutput: true },
        { id: "no-schema-model", structuredOutput: false },
        { id: "vendor/small:free", structuredOutput: true },
        { id: "vendor/zero-priced", structuredOutput: true, price: { input: 0, output: 0 } },
      ];
    },
  };
}

async function setup(serverKeys: Partial<Record<"anthropic" | "openrouter" | "gemini" | "openai", string>> = {}) {
  const db = new Database(":memory:");
  const mailer = new ConsoleMailer(() => {});
  const auth = await createAuth({ db, appOrigin: ORIGIN, secret: randomBytes(32).toString("base64"), mailer, rateLimit: false });
    const store = new Store(db);
  const logs: string[] = [];
  const seen = { keys: [] as string[], requests: [] as ModelRequest[] };
  const app = createApp({
    config: { appOrigin: ORIGIN, keyRing: parseMasterKeys(randomBytes(32).toString("base64")), maxConcurrent: 2, maxPerWindow: 30, maxRows: 300, serverKeys },
    auth,
    store,
    log: jsonLogger((line) => logs.push(line)),
    providers: fakeProviders(seen),
    clientIp: () => "127.0.0.1",
  });
  const request = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== "GET") headers.set("origin", headers.get("origin") ?? ORIGIN);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    return app.request(`http://localhost${path}`, { ...init, headers });
  };
  /** Signs up, follows the verification link, and returns the session cookie. */
  const signUp = async (email: string, verify = true) => {
    const res = await request("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, password: "correct horse battery", name: email }) });
    expect(res.status).toBe(200);
    let cookie = cookieOf(res);
    if (verify) {
      const link = [...mailer.sent].reverse().find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0];
      const url = new URL(link);
      const verified = await request(`${url.pathname}${url.search}`, { cookie });
      expect(verified.status).toBeLessThan(400);
      cookie = cookieOf(verified) || cookie;
    }
    return cookie;
  };
  return { db, app, store, logs, seen, mailer, request, signUp };
}

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

/** Server-sent events as [event, data] pairs. */
async function events(res: Response): Promise<[string, unknown][]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return [event, JSON.parse(data)];
    });
}

const PATTERN = "Rnd 1: 6 sc in magic ring. (6)\nRnd 2: 2 sc in each st around. (12)";

describe("keys", () => {
  const ring = new KeyRing(new Map([[1, randomBytes(32)]]), 1);

  it("round-trips, and fails for another user or provider", () => {
    const sealed = ring.seal(GOOD_KEY, "u1", "anthropic");
    expect(ring.open(sealed, "u1", "anthropic")).toBe(GOOD_KEY);
    expect(sealed.ciphertext.includes(Buffer.from(GOOD_KEY))).toBe(false);
    expect(() => ring.open(sealed, "u2", "anthropic")).toThrow();
    expect(() => ring.open(sealed, "u1", "openai")).toThrow();
    expect(ring.seal(GOOD_KEY, "u1", "anthropic").nonce.equals(sealed.nonce)).toBe(false);
  });

  it("opens rows sealed with an older master key after rotation", () => {
    const old = randomBytes(32).toString("base64");
    const sealed = parseMasterKeys(old).seal(GOOD_KEY, "u1", "gemini");
    const rotated = parseMasterKeys(`2:${randomBytes(32).toString("base64")},1:${old}`);
    expect(rotated.current).toBe(2);
    expect(rotated.open(sealed, "u1", "gemini")).toBe(GOOD_KEY);
    expect(rotated.seal(GOOD_KEY, "u1", "gemini").keyVersion).toBe(2);
  });

  it("redacts secret fields and scrubs echoed keys", () => {
    expect(redact({ headers: { "X-Provider-Key": GOOD_KEY }, body: { key: GOOD_KEY, ok: 1 } })).toEqual({
      headers: { "X-Provider-Key": "[redacted]" },
      body: { key: "[redacted]", ok: 1 },
    });
    expect(scrub(`bad key ${GOOD_KEY} or sk-***${GOOD_KEY.slice(-8)}`, [GOOD_KEY])).not.toContain(GOOD_KEY.slice(-8));
  });
});

describe("server", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("lets a guest translate with a header key and stores nothing about the key", async () => {
    const res = await s.request("/api/translate", {
      method: "POST",
      headers: { "x-provider-key": GOOD_KEY },
      body: JSON.stringify({ english: PATTERN, provider: "anthropic" }),
    });
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs.map(([e]) => e)).toEqual(["row", "row", "done"]);
    expect((evs[0]![1] as { cp: string }).cp).toBe("ring\n6sc");
    expect(evs[2]![1]).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", requests: 2 });
    expect(s.seen.keys).toEqual([GOOD_KEY]);

    const dump = s.db.serialize();
    expect(dump.includes(Buffer.from(GOOD_KEY))).toBe(false);
    expect(dump.includes(Buffer.from(GOOD_KEY.slice(-8)))).toBe(false);
    expect(s.logs.join("\n")).not.toContain(GOOD_KEY.slice(-8));
  });

  it("answers a repeated pattern from the shared cache, unless the cache is off", async () => {
    const send = (cache?: boolean) =>
      s.request("/api/translate", {
        method: "POST",
        headers: { "x-provider-key": GOOD_KEY },
        body: JSON.stringify({ english: PATTERN, cache }),
      });
    await events(await send());
    const before = s.seen.requests.length;
    const again = await events(await send());
    expect(s.seen.requests.length).toBe(before);
    expect(again.filter(([e]) => e === "row").every(([, t]) => (t as { cached?: boolean }).cached)).toBe(true);
    await events(await send(false));
    expect(s.seen.requests.length).toBe(before + 2);
  });

  it("keeps a user's edit and re-translates one row", async () => {
    const english = PATTERN;
    const first = await events(await s.request("/api/translate", { method: "POST", headers: { "x-provider-key": GOOD_KEY }, body: JSON.stringify({ english, cache: false }) }));
    const [r1, r2] = first.filter(([e]) => e === "row").map(([, t]) => t as { rowId: string });
    const edited = await events(
      await s.request("/api/translate", {
        method: "POST",
        headers: { "x-provider-key": GOOD_KEY },
        body: JSON.stringify({ english, cache: false, edits: { [r1!.rowId]: "ring\n6sc" } }),
      }),
    );
    expect(edited.filter(([e]) => e === "row").map(([, t]) => (t as { rowId: string }).rowId)).toEqual([r2!.rowId]);

    const row = await events(
      await s.request("/api/translate/row", {
        method: "POST",
        headers: { "x-provider-key": GOOD_KEY },
        body: JSON.stringify({ english, rowId: r2!.rowId, translations: { [r1!.rowId]: r1 }, rejected: ["read as a flat circle"] }),
      }),
    );
    expect(row.map(([e]) => e)).toEqual(["row", "done"]);
    const last = s.seen.requests.at(-1)!;
    expect(JSON.stringify(last.messages)).toContain("read as a flat circle");
  });

  it("asks for a key when there is none", async () => {
    const res = await s.request("/api/translate", { method: "POST", body: JSON.stringify({ english: PATTERN }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_key", provider: "anthropic" });
    expect((await s.request("/api/models/gemini")).status).toBe(409);
  });

  it("rejects state changes from another origin", async () => {
    const res = await s.request("/api/translate", {
      method: "POST",
      headers: { origin: "https://evil.example", "x-provider-key": GOOD_KEY },
      body: JSON.stringify({ english: PATTERN }),
    });
    expect(res.status).toBe(403);
    expect(s.seen.keys).toEqual([]);
  });

  it("requires a session for keys, settings and account deletion", async () => {
    expect((await s.request("/api/keys")).status).toBe(401);
    expect((await s.request("/api/keys/anthropic", { method: "PUT", body: JSON.stringify({ key: GOOD_KEY }) })).status).toBe(401);
    expect((await s.request("/api/settings")).status).toBe(401);
    expect((await s.request("/api/account", { method: "DELETE" })).status).toBe(401);
  });

  it("lists models the key can use, schema-capable only, default first", async () => {
    const res = await s.request("/api/models/anthropic", { headers: { "x-provider-key": GOOD_KEY } });
    const body = (await res.json()) as { models: { id: string; recommended: boolean; price: unknown }[] };
    expect(body.models.map((m) => m.id)).toEqual(["claude-opus-5-5", "fake-model", "vendor/small:free", "vendor/zero-priced"]);
    expect(body.models.filter((m) => (m as { free?: boolean }).free).map((m) => m.id)).toEqual(["vendor/small:free", "vendor/zero-priced"]);
    expect(body.models[0]!.recommended).toBe(true);
    expect(body.models[0]!.price).toMatchObject({ input: 4 });
    const bad = await s.request("/api/models/anthropic", { headers: { "x-provider-key": "bad-key-12345678" } });
    expect(bad.status).toBe(401);
    expect(await bad.text()).not.toContain("12345678");
  });

  it("saves a key only after email verification, encrypted, and uses it", async () => {
    const unverified = await s.signUp("new@example.com", false);
    const early = await s.request("/api/keys/anthropic", { method: "PUT", cookie: unverified, body: JSON.stringify({ key: GOOD_KEY }) });
    expect(early.status).toBe(403);

    const cookie = await s.signUp("kp@example.com");
    const rejected = await s.request("/api/keys/anthropic", { method: "PUT", cookie, body: JSON.stringify({ key: "bad-key-12345678" }) });
    expect(rejected.status).toBe(400);
    const saved = await s.request("/api/keys/anthropic", { method: "PUT", cookie, body: JSON.stringify({ key: GOOD_KEY }) });
    expect(await saved.json()).toEqual({ provider: "anthropic", last4: GOOD_KEY.slice(-4), status: "ok" });

    const list = await (await s.request("/api/keys", { cookie })).json();
    expect(JSON.stringify(list)).not.toContain(GOOD_KEY.slice(0, -4));
    expect(s.db.serialize().includes(Buffer.from(GOOD_KEY))).toBe(false);

    s.seen.keys.length = 0;
    const translated = await events(await s.request("/api/translate", { method: "POST", cookie, body: JSON.stringify({ english: PATTERN }) }));
    expect(translated.at(-1)![0]).toBe("done");
    expect(s.seen.keys).toEqual([GOOD_KEY]);
    expect(s.logs.join("\n")).not.toContain(GOOD_KEY.slice(-8));
  });

  it("marks a saved key invalid when the provider rejects it in use", async () => {
    const cookie = await s.signUp("kp@example.com");
    const userId = (s.db.prepare('SELECT id FROM "user" WHERE email = ?').get("kp@example.com") as { id: string }).id;
    // Accepted when saved, revoked by the time it is used.
    await s.request("/api/keys/anthropic", { method: "PUT", cookie, body: JSON.stringify({ key: REVOKED_KEY }) });
    const evs = await events(await s.request("/api/translate", { method: "POST", cookie, body: JSON.stringify({ english: PATTERN, cache: false }) }));
    expect(evs.at(-1)).toEqual(["error", expect.objectContaining({ error: "key_rejected" })]);
    expect(JSON.stringify(evs)).not.toContain(REVOKED_KEY.slice(-8));
    expect(s.store.listKeys(userId)[0]!.status).toBe("invalid");
    // An invalid saved key is not used: the app asks for a new one.
    expect((await s.request("/api/models/anthropic", { cookie })).status).toBe(409);
  });

  it("keeps one user's key away from another", async () => {
    const a = await s.signUp("a@example.com");
    const b = await s.signUp("b@example.com");
    await s.request("/api/keys/anthropic", { method: "PUT", cookie: a, body: JSON.stringify({ key: GOOD_KEY }) });
    await s.request("/api/keys/anthropic", { method: "PUT", cookie: b, body: JSON.stringify({ key: OTHER_KEY }) });
    expect(((await (await s.request("/api/keys", { cookie: b })).json()) as { keys: { last4: string }[] }).keys.map((k) => k.last4)).toEqual([OTHER_KEY.slice(-4)]);

    s.seen.keys.length = 0;
    await events(await s.request("/api/translate", { method: "POST", cookie: b, body: JSON.stringify({ english: PATTERN, cache: false }) }));
    expect(s.seen.keys).toEqual([OTHER_KEY]);

    // b deleting "their" anthropic key leaves a's alone.
    await s.request("/api/keys/anthropic", { method: "DELETE", cookie: b });
    expect(((await (await s.request("/api/keys", { cookie: a })).json()) as { keys: unknown[] }).keys).toHaveLength(1);
  });

  it("does not mark a saved key invalid when a header key is rejected", async () => {
    const cookie = await s.signUp("kp@example.com");
    const userId = (s.db.prepare('SELECT id FROM "user" WHERE email = ?').get("kp@example.com") as { id: string }).id;
    await s.request("/api/keys/anthropic", { method: "PUT", cookie, body: JSON.stringify({ key: GOOD_KEY }) });
    const evs = await events(
      await s.request("/api/translate", { method: "POST", cookie, headers: { "x-provider-key": REVOKED_KEY }, body: JSON.stringify({ english: PATTERN, cache: false }) }),
    );
    expect(evs.at(-1)![0]).toBe("error");
    expect(s.store.listKeys(userId)[0]!.status).toBe("ok");
  });

  it("deletes the account with its keys and settings", async () => {
    const cookie = await s.signUp("kp@example.com");
    await s.request("/api/keys/anthropic", { method: "PUT", cookie, body: JSON.stringify({ key: GOOD_KEY }) });
    await s.request("/api/settings", { method: "PUT", cookie, body: JSON.stringify({ provider: "anthropic", model: "fake-model", effort: "low", cacheEnabled: false }) });
    expect(await (await s.request("/api/settings", { cookie })).json()).toMatchObject({ model: "fake-model", cacheEnabled: false });
    const res = await s.request("/api/account", { method: "DELETE", cookie });
    expect(res.status).toBe(200);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM provider_key").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM user_settings").get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({ n: 0 });
    expect((await s.request("/api/keys", { cookie })).status).toBe(401);
  });

  it("limits translations at once and per window", () => {
    const limits = new TranslationLimits(2, 3);
    const a = limits.acquire("ip");
    const b = limits.acquire("ip");
    expect(limits.acquire("ip")).toEqual({ refused: "busy" });
    if ("release" in a) a.release();
    expect("release" in limits.acquire("ip")).toBe(true);
    if ("release" in b) b.release();
    expect(limits.acquire("ip")).toEqual({ refused: "rate_limited" });
    expect("release" in limits.acquire("other ip")).toBe(true);
  });
});

describe("development keys from the environment", () => {
  const SERVER_KEY = "sk-or-server-dev-key-5566778899";

  it("are read in development and ignored in production", () => {
    const secrets = { KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"), BETTER_AUTH_SECRET: "x".repeat(32) };
    const dev = loadConfig({ ...secrets, OPENROUTER_API_KEY: ` ${SERVER_KEY} `, GEMINI_API_KEY: "" });
    expect(dev.serverKeys).toEqual({ openrouter: SERVER_KEY });
    const prod = loadConfig({ ...secrets, NODE_ENV: "production", OPENROUTER_API_KEY: SERVER_KEY });
    expect(prod.serverKeys).toEqual({});
  });

  it("are used when the browser sends no key, and named but never shown", async () => {
    const s = await setup({ openrouter: SERVER_KEY });
    const health = await (await s.request("/api/health")).text();
    expect(JSON.parse(health).serverKeys).toEqual(["openrouter"]);
    expect(health).not.toContain(SERVER_KEY.slice(-8));

    const models = await s.request("/api/models/openrouter");
    expect(models.status).toBe(200);
    expect(await models.text()).not.toContain(SERVER_KEY.slice(-8));
    expect((await s.request("/api/models/gemini")).status).toBe(409);

    const evs = await events(
      await s.request("/api/translate", { method: "POST", body: JSON.stringify({ english: PATTERN, provider: "openrouter", model: "fake-model", cache: false }) }),
    );
    expect(evs.at(-1)![0]).toBe("done");
    expect(s.seen.keys).toEqual([SERVER_KEY, SERVER_KEY]);
    expect(s.logs.join("\n")).not.toContain(SERVER_KEY.slice(-8));
  });

  it("come after a key the browser sends and a key the user saved", async () => {
    const s = await setup({ anthropic: SERVER_KEY });
    await events(await s.request("/api/translate", { method: "POST", headers: { "x-provider-key": GOOD_KEY }, body: JSON.stringify({ english: PATTERN, cache: false }) }));
    expect(s.seen.keys).toEqual([GOOD_KEY]);

    const cookie = await s.signUp("kp@example.com");
    await s.request("/api/keys/anthropic", { method: "PUT", cookie, body: JSON.stringify({ key: OTHER_KEY }) });
    s.seen.keys.length = 0;
    await events(await s.request("/api/translate", { method: "POST", cookie, body: JSON.stringify({ english: PATTERN, cache: false }) }));
    expect(s.seen.keys).toEqual([OTHER_KEY]);
  });
});
