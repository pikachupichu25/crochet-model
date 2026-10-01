// Account screens (docs/SPEC.md §9, FR-7.x): sign in, sign up and password
// reset; Settings with API keys and translation defaults. Guests get the
// translation settings too, kept in the browser.

import { useEffect, useState, type FormEvent } from "react";
import { api, auth, describeError, KEY_PAGES, PROVIDER_NAMES, type Effort, type ProviderId } from "../api.ts";
import { refreshKeys, refreshSession, setTranslationSettings, useApp } from "../store.ts";
import { Dialog } from "./Dialog.tsx";

export type AuthMode = "signin" | "signup" | "forgot" | "reset";

const TITLES: Record<AuthMode, string> = {
  signin: "Sign in",
  signup: "Create an account",
  forgot: "Reset your password",
  reset: "Choose a new password",
};

function message(e: unknown): string {
  const text = describeError(e);
  // Better Auth's codes, in plain words.
  if (/INVALID_EMAIL_OR_PASSWORD/i.test(text) || /invalid email or password/i.test(text)) return "That email and password do not match.";
  if (/USER_ALREADY_EXISTS/i.test(text) || /already exists/i.test(text)) return "There is already an account with that email. Sign in instead.";
  if (/PASSWORD_TOO_SHORT/i.test(text) || /too short/i.test(text)) return "Use at least 8 characters.";
  if (/too many/i.test(text) || /429/.test(text)) return "Too many attempts. Wait a minute and try again.";
  return text;
}

export function AuthDialog({ state, onClose, onNotice }: { state?: { mode: AuthMode; token?: string }; onClose: () => void; onNotice: (text: string) => void }) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (state) {
      setMode(state.mode);
      setError(undefined);
      setPassword("");
    }
  }, [state]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "signin") {
        await auth.signIn(email, password);
        await refreshSession();
        onClose();
      } else if (mode === "signup") {
        await auth.signUp(email, password);
        await refreshSession();
        onClose();
        onNotice(`Account created. We sent a link to ${email}: confirm your address before saving keys.`);
      } else if (mode === "forgot") {
        await auth.requestReset(email);
        onClose();
        onNotice(`If ${email} has an account, a reset link is on its way.`);
      } else {
        await auth.resetPassword(state!.token!, password);
        setMode("signin");
        setPassword("");
        onNotice("Password changed. Sign in with the new one.");
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!state} onClose={onClose} title={TITLES[mode]}>
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        {mode === "signin" && <p className="hint">An account only saves your API keys and settings. Everything else works without one.</p>}
        {mode !== "reset" && (
          <label className="field">
            <span>Email</span>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        {mode !== "forgot" && (
          <label className="field">
            <span>{mode === "reset" ? "New password" : "Password"}</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="callout bad" role="alert">
            {error}
          </p>
        )}
        <button className="button primary wide" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Set password"}
        </button>
        <p className="auth-switch">
          {mode === "signin" && (
            <>
              <button type="button" className="link" onClick={() => setMode("signup")}>
                Create an account
              </button>
              <button type="button" className="link" onClick={() => setMode("forgot")}>
                Forgot your password?
              </button>
            </>
          )}
          {(mode === "signup" || mode === "forgot") && (
            <button type="button" className="link" onClick={() => setMode("signin")}>
              I have an account
            </button>
          )}
        </p>
      </form>
    </Dialog>
  );
}

const PROVIDERS: ProviderId[] = ["anthropic", "openrouter", "gemini", "openai"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function SettingsDialog({ open, onClose, onSignIn }: { open: boolean; onClose: () => void; onSignIn: () => void }) {
  const user = useApp((s) => s.user);
  const effort = useApp((s) => s.effort);
  const cacheEnabled = useApp((s) => s.cacheEnabled);

  useEffect(() => {
    if (open) void refreshKeys();
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="Settings" wide>
      <section className="settings-section">
        <h3>API keys</h3>
        {user ? (
          <>
            {!user.emailVerified && <VerifyNotice email={user.email} />}
            <div className="key-cards">
              {PROVIDERS.map((p) => (
                <KeyCard key={p} provider={p} disabled={!user.emailVerified} />
              ))}
            </div>
          </>
        ) : (
          <p className="hint">
            Without an account, keys are kept in this tab only and asked for again after a reload.{" "}
            <button className="link" onClick={onSignIn}>
              Sign in
            </button>{" "}
            to save them, encrypted, on our server.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h3>Translation</h3>
        <p className="hint">The provider and model are chosen next to Translate. {user ? "Saved to your account." : "Kept in this browser."}</p>
        <div className="picker-grid">
          <label className="field">
            <span>Effort</span>
            <select value={effort} onChange={(e) => setTranslationSettings({ effort: e.target.value as Effort })}>
              {EFFORTS.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={cacheEnabled} onChange={(e) => setTranslationSettings({ cacheEnabled: e.target.checked })} />
            <span>
              Use the translation cache
              <small>A pattern someone already translated with the same model costs nothing. Off: nothing about your patterns is kept on our server.</small>
            </span>
          </label>
        </div>
      </section>

      {user && <DangerZone email={user.email} onDone={onClose} />}
    </Dialog>
  );
}

function VerifyNotice({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  return (
    <p className="callout warn">
      Confirm {email} to save keys: follow the link we emailed you.{" "}
      <button className="link" disabled={sent} onClick={() => void auth.resendVerification(email).then(() => setSent(true))}>
        {sent ? "Sent again" : "Send it again"}
      </button>
    </p>
  );
}

function KeyCard({ provider, disabled }: { provider: ProviderId; disabled: boolean }) {
  const saved = useApp((s) => s.savedKeys.find((k) => k.provider === provider));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.saveKey(provider, draft);
      setDraft("");
      await refreshKeys();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    await api.deleteKey(provider).catch(() => {});
    await refreshKeys();
    setBusy(false);
  };

  return (
    <div className={`key-card ${saved?.status ?? "none"}`}>
      <div className="key-card-head">
        <strong>{PROVIDER_NAMES[provider]}</strong>
        <a href={KEY_PAGES[provider]} target="_blank" rel="noreferrer noopener">
          Get a key
        </a>
      </div>
      {saved ? (
        <p className="key-line">
          <code>••••{saved.last4}</code>
          <span className={`pill ${saved.status}`}>{saved.status === "ok" ? "working" : saved.status === "invalid" ? "rejected: replace it" : "not checked yet"}</span>
          <small>
            added {new Date(saved.createdAt).toLocaleDateString()}
            {saved.lastUsedAt ? `, last used ${new Date(saved.lastUsedAt).toLocaleDateString()}` : ""}
          </small>
        </p>
      ) : (
        <p className="key-line faint">No key saved.</p>
      )}
      <form
        className="key-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          autoComplete="off"
          placeholder={saved ? "Replace with a new key" : "Paste a key to save"}
          value={draft}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`${PROVIDER_NAMES[provider]} key`}
        />
        <button className="button small" disabled={disabled || busy || draft.trim().length < 8}>
          {busy ? "Checking…" : "Save"}
        </button>
        {saved && (
          <button type="button" className="link danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        )}
      </form>
      {error && <p className="row-error">{error}</p>}
    </div>
  );
}

function DangerZone({ email, onDone }: { email: string; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAccount();
      await refreshSession();
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section danger-zone">
      <h3>Delete account</h3>
      <p className="hint">Deletes your account, every saved key and your settings at once. Type your email to confirm.</p>
      <div className="key-form">
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={email} aria-label="Type your email to confirm" />
        <button className="button small danger" disabled={busy || typed.trim() !== email} onClick={() => void remove()}>
          Delete account
        </button>
      </div>
    </section>
  );
}
