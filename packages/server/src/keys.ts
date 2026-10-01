// Users' provider keys at rest and in logs (docs/SPEC.md §8.3, FR-7.6).
//
// AES-256-GCM with a fresh 12-byte nonce per save. The additional
// authenticated data is `user_id:provider`, so a ciphertext copied to another
// user's row, or to another provider, does not decrypt. Master keys come from
// the environment, never from the database; `key_version` says which one
// encrypted a row, so they can be rotated.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const TAG_BYTES = 16;

export interface SealedKey {
  /** Ciphertext with the GCM tag appended. */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export class KeyRing {
  private readonly keys: ReadonlyMap<number, Buffer>;
  readonly current: number;

  /** `keys`: master keys by version, 32 bytes each; `current` encrypts new saves. */
  constructor(keys: ReadonlyMap<number, Buffer>, current: number) {
    for (const [version, key] of keys) {
      if (key.length !== 32) throw new Error(`master key version ${version} is ${key.length} bytes, not 32`);
    }
    if (!keys.has(current)) throw new Error(`no master key with version ${current}`);
    this.keys = keys;
    this.current = current;
  }

  seal(plaintext: string, userId: string, provider: string): SealedKey {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.current)!, nonce);
    cipher.setAAD(Buffer.from(`${userId}:${provider}`));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce, keyVersion: this.current };
  }

  /** Throws when the row was tampered with or moved to another user or provider. */
  open(sealed: SealedKey, userId: string, provider: string): string {
    const key = this.keys.get(sealed.keyVersion);
    if (!key) throw new Error(`no master key with version ${sealed.keyVersion}`);
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(Buffer.from(`${userId}:${provider}`));
    decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

/**
 * Reads `KEY_ENCRYPTION_KEY`: one base64 key (version 1), or versioned keys
 * newest first, `3:<base64>,2:<base64>`. The first is the current one.
 */
export function parseMasterKeys(value: string): KeyRing {
  const keys = new Map<number, Buffer>();
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const m = /^(\d+):(.+)$/.exec(part);
    const version = m ? Number(m[1]) : 1;
    keys.set(version, Buffer.from(m ? m[2]! : part, "base64"));
  }
  if (keys.size === 0) throw new Error("KEY_ENCRYPTION_KEY is empty");
  return new KeyRing(keys, keys.keys().next().value!);
}

export function last4(key: string): string {
  return key.trim().slice(-4);
}

/** Header and field names whose values are never logged. */
const SECRET_HEADERS = new Set(["x-provider-key", "authorization", "x-api-key", "x-goog-api-key", "cookie", "set-cookie"]);
const SECRET_FIELDS = new Set(["key", "apikey", "api_key", "password", "newpassword", "token"]);

/** A copy with secret fields and headers replaced, for logs. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const name = k.toLowerCase();
    out[k] = SECRET_HEADERS.has(name) || SECRET_FIELDS.has(name) ? "[redacted]" : redact(v);
  }
  return out;
}

/**
 * Removes a key from text that may quote it: provider error messages
 * sometimes echo part of the key they rejected.
 */
export function scrub(text: string, secrets: Iterable<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
    // A masked echo such as "sk-ab***...wxyz" still carries the last characters.
    out = out.split(secret.slice(-8)).join("[redacted]");
  }
  return out;
}
