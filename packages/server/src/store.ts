// Our tables next to Better Auth's (docs/SPEC.md §8.2, §8.4): saved provider
// keys, settings and the shared translation cache.

import type Database from "better-sqlite3";
import type { CachedRow, RowCache } from "@crochet-model/translator";
import type { SealedKey } from "./keys.ts";

export type KeyStatus = "ok" | "invalid" | "unchecked";

export interface SavedKeyInfo {
  provider: string;
  last4: string;
  status: KeyStatus;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Settings {
  provider: string | null;
  model: string | null;
  effort: string | null;
  cacheEnabled: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_key (
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  ciphertext   BLOB NOT NULL,
  nonce        BLOB NOT NULL,
  key_version  INTEGER NOT NULL,
  last4        TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id  TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT, model TEXT, effort TEXT,
  cache_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS translation_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class Store {
  readonly db: Database.Database;

  /** Call after Better Auth's migrations: the tables reference its `user`. */
  constructor(db: Database.Database) {
    this.db = db;
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
  }

  listKeys(userId: string): SavedKeyInfo[] {
    return this.db
      .prepare(
        "SELECT provider, last4, status, created_at AS createdAt, last_used_at AS lastUsedAt FROM provider_key WHERE user_id = ? ORDER BY provider",
      )
      .all(userId) as SavedKeyInfo[];
  }

  getKey(userId: string, provider: string): (SealedKey & { status: KeyStatus }) | undefined {
    const row = this.db
      .prepare("SELECT ciphertext, nonce, key_version AS keyVersion, status FROM provider_key WHERE user_id = ? AND provider = ?")
      .get(userId, provider) as (SealedKey & { status: KeyStatus }) | undefined;
    return row;
  }

  putKey(userId: string, provider: string, sealed: SealedKey, last4: string, status: KeyStatus): void {
    this.db
      .prepare(
        `INSERT INTO provider_key (user_id, provider, ciphertext, nonce, key_version, last4, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
           key_version = excluded.key_version, last4 = excluded.last4, status = excluded.status,
           created_at = excluded.created_at, last_used_at = NULL`,
      )
      .run(userId, provider, sealed.ciphertext, sealed.nonce, sealed.keyVersion, last4, status, Date.now());
  }

  deleteKey(userId: string, provider: string): boolean {
    return this.db.prepare("DELETE FROM provider_key WHERE user_id = ? AND provider = ?").run(userId, provider).changes > 0;
  }

  setKeyStatus(userId: string, provider: string, status: KeyStatus): void {
    this.db.prepare("UPDATE provider_key SET status = ? WHERE user_id = ? AND provider = ?").run(status, userId, provider);
  }

  touchKey(userId: string, provider: string): void {
    this.db.prepare("UPDATE provider_key SET last_used_at = ? WHERE user_id = ? AND provider = ?").run(Date.now(), userId, provider);
  }

  getSettings(userId: string): Settings {
    const row = this.db
      .prepare("SELECT provider, model, effort, cache_enabled AS cacheEnabled FROM user_settings WHERE user_id = ?")
      .get(userId) as (Omit<Settings, "cacheEnabled"> & { cacheEnabled: number }) | undefined;
    return row
      ? { ...row, cacheEnabled: row.cacheEnabled === 1 }
      : { provider: null, model: null, effort: null, cacheEnabled: true };
  }

  putSettings(userId: string, s: Settings): void {
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, provider, model, effort, cache_enabled) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
           effort = excluded.effort, cache_enabled = excluded.cache_enabled`,
      )
      .run(userId, s.provider, s.model, s.effort, s.cacheEnabled ? 1 : 0);
  }

  /** Deletes the user and, by cascade, their keys, settings, sessions and accounts. */
  deleteUser(userId: string): void {
    this.db.transaction(() => {
      // Explicit, so nothing depends on how Better Auth declared its foreign keys.
      this.db.prepare("DELETE FROM provider_key WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(userId);
      this.db.prepare('DELETE FROM "session" WHERE userId = ?').run(userId);
      this.db.prepare('DELETE FROM "account" WHERE userId = ?').run(userId);
      this.db.prepare('DELETE FROM "user" WHERE id = ?').run(userId);
    })();
  }

  /** The shared translation cache: an entry only answers the same English (§8.4). */
  rowCache(): RowCache {
    const get = this.db.prepare("SELECT value FROM translation_cache WHERE key = ?");
    const set = this.db.prepare(
      "INSERT INTO translation_cache (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    return {
      get: (key) => {
        const row = get.get(key) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as CachedRow) : undefined;
      },
      set: (key, value) => void set.run(key, JSON.stringify(value), Date.now()),
    };
  }
}
