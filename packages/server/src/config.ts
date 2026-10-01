// Server settings from the environment (docs/SPEC.md §8).
//
//   PORT                 default 5181
//   APP_ORIGIN           the app's origin as the browser sees it; default http://localhost:5180
//                        (the Vite dev server, which proxies /api here)
//   DATABASE_PATH        SQLite file; default packages/server/data/app.db
//   KEY_ENCRYPTION_KEY   master key(s) for saved provider keys (keys.ts)
//   BETTER_AUTH_SECRET   signs session cookies
//   NODE_ENV             "production" requires both secrets and a mail transport
//
// In development a missing secret is generated once and kept in
// data/dev-secrets.json (git-ignored), so saved keys survive restarts.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMasterKeys, type KeyRing } from "./keys.ts";

export interface ServerConfig {
  port: number;
  appOrigin: string;
  databasePath: string;
  keyRing: KeyRing;
  authSecret: string;
  production: boolean;
  /** At most this many translations at once per user or IP (§8.4). */
  maxConcurrent: number;
  /** Translation requests per user or IP per 10 minutes. */
  maxPerWindow: number;
  /** Rows in one pattern (§8.4). */
  maxRows: number;
}

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const secret = (name: "KEY_ENCRYPTION_KEY" | "BETTER_AUTH_SECRET"): string => {
    const value = env[name];
    if (value) return value;
    if (production) throw new Error(`${name} must be set in production`);
    return devSecret(name);
  };
  return {
    port: Number(env.PORT ?? 5181),
    appOrigin: env.APP_ORIGIN ?? "http://localhost:5180",
    databasePath: env.DATABASE_PATH ?? `${DATA_DIR}app.db`,
    keyRing: parseMasterKeys(secret("KEY_ENCRYPTION_KEY")),
    authSecret: secret("BETTER_AUTH_SECRET"),
    production,
    maxConcurrent: 2,
    maxPerWindow: 30,
    maxRows: 300,
  };
}

function devSecret(name: string): string {
  const file = `${DATA_DIR}dev-secrets.json`;
  const secrets: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!secrets[name]) {
    secrets[name] = randomBytes(32).toString("base64");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    console.warn(`${name} is not set: generated a development value in ${file}`);
  }
  return secrets[name]!;
}
