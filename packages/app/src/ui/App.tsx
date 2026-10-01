// The app (docs/SPEC.md §9): Pattern and Review on the left, the model on the
// right, side by side on wide screens. No sign-in wall: every screen works
// signed out; signing in only saves keys and settings.

import { useEffect, useState } from "react";
import { runCheck } from "../check.ts";
import { refreshSession, signOut, useApp } from "../store.ts";
import { AuthDialog, SettingsDialog, type AuthMode } from "./Account.tsx";
import { ModelPanel } from "./ModelPanel.tsx";
import { PatternInput } from "./PatternInput.tsx";
import { Review } from "./Review.tsx";

type Tab = "pattern" | "review";

export function App() {
  const user = useApp((s) => s.user);
  const translating = useApp((s) => s.translating);
  const [tab, setTab] = useState<Tab>("pattern");
  const [auth, setAuth] = useState<{ mode: AuthMode; token?: string } | undefined>();
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    void refreshSession();
    void runCheck();
    // Links from verification and reset emails come back here.
    const q = new URLSearchParams(location.search);
    if (q.get("reset") && q.get("token")) setAuth({ mode: "reset", token: q.get("token")! });
    if (q.get("verified")) setNotice("Email confirmed. You can now save API keys to your account.");
    if (q.get("error")) setNotice(`That link did not work (${q.get("error")}). Ask for a new one.`);
    if ([...q.keys()].length) history.replaceState(null, "", location.pathname);
  }, []);

  useEffect(() => {
    if (translating) setTab("review");
  }, [translating]);

  return (
    <div className="shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Crochet Model, home">
          <YarnMark />
          <span>
            Crochet <em>Model</em>
          </span>
        </a>
        <p className="tagline">English pattern in, CrochetPARADE and a 3D model out.</p>
        <nav className="account">
          {user ? (
            <>
              <span className="who" title={user.email}>
                {user.email}
              </span>
              <button className="link" onClick={() => setSettings(true)}>
                Settings
              </button>
              <button className="link" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <button className="link" onClick={() => setSettings(true)}>
                Settings
              </button>
              <button className="button small" onClick={() => setAuth({ mode: "signin" })}>
                Sign in
              </button>
            </>
          )}
        </nav>
      </header>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="icon-button" onClick={() => setNotice(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="left" aria-label="Pattern and review">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "pattern"} onClick={() => setTab("pattern")}>
              <span className="tab-num">1</span> Pattern
            </button>
            <button role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
              <span className="tab-num">2</span> Review
            </button>
          </div>
          {tab === "pattern" ? (
            <PatternInput onSignIn={() => setAuth({ mode: "signin" })} onReview={() => setTab("review")} />
          ) : (
            <Review onEditPattern={() => setTab("pattern")} />
          )}
        </section>
        <ModelPanel />
      </main>

      <AuthDialog state={auth} onClose={() => setAuth(undefined)} onNotice={setNotice} />
      <SettingsDialog open={settings} onClose={() => setSettings(false)} onSignIn={() => (setSettings(false), setAuth({ mode: "signin" }))} />
    </div>
  );
}

/** A ball of yarn: three crossing strands. */
function YarnMark() {
  return (
    <svg className="yarn-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" />
      <path d="M5 11c7 2 15 9 20 17M4 18c8-1 16 2 22 8M9 5c4 6 6 15 4 24M17 3c-1 8 3 18 11 22" />
      <path className="tail" d="M28 25c2 1 3 3 2 5" />
    </svg>
  );
}
