// Accounts through Better Auth (docs/SPEC.md §8.2): email and password,
// cookie sessions, email verification and password reset. We write no
// password or session code. Better Auth owns the `user`, `session`, `account`
// and `verification` tables.

import type Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type { Mailer } from "./mail.ts";

export interface AuthOptions {
  db: Database.Database;
  /** The app's origin; /api/auth is served from it (through the dev proxy in development). */
  appOrigin: string;
  secret: string;
  mailer: Mailer;
  /** Rate limits are on by default; tests that sign in many times turn them off. */
  rateLimit?: boolean;
}

function authOptions(o: AuthOptions) {
  return {
    database: o.db,
    baseURL: o.appOrigin,
    basePath: "/api/auth",
    secret: o.secret,
    trustedOrigins: [o.appOrigin],
    emailAndPassword: {
      enabled: true,
      // Signing in does not need a verified address; saving a key does (keys route).
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) =>
        o.mailer.send({ to: user.email, subject: "Reset your password", text: `Set a new password: ${url}` }),
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) =>
        o.mailer.send({ to: user.email, subject: "Confirm your email", text: `Confirm your address: ${url}` }),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: o.rateLimit ?? true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
      },
    },
  } satisfies BetterAuthOptions;
}

/** Creates or updates Better Auth's tables first, so it starts on a matching schema. */
export async function createAuth(o: AuthOptions) {
  const options = authOptions(o);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return betterAuth(options);
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
