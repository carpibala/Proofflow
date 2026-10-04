"use client";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Languages } from "lucide-react";
import { translations, type Language } from "@/lib/i18n";
type User = { id: string; username: string };
const UserContext = createContext<User | null>(null);
export function useUser() {
  const user = useContext(UserContext);
  if (!user) throw new Error("Authentication required");
  return user;
}
export function draftStorageKey(userId: string) { return `proofflow-local-draft-v2:${userId}`; }
const languageKey = "proofflow-ui-language";
// Errors are stored as a lookup key with the server message as fallback, so a visible error
// follows the selected language instead of freezing in whichever language it was raised.
type AuthError = { key: string; fallback?: string };
export default function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<AuthError | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [language, setLanguage] = useState<Language>("zh");
  const t = translations[language];
  const errorText = (value: AuthError | null) => {
    if (!value) return "";
    const known = t.auth.errors as Record<string, string>;
    return known[value.key] ?? value.fallback ?? t.auth.errors.generic;
  };
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = localStorage.getItem(languageKey);
        if (saved === "zh" || saved === "en") {
          setLanguage(saved);
          document.documentElement.lang = saved === "zh" ? "zh-CN" : "en";
        }
      } catch {
        // Language preference is optional when browser storage is unavailable.
      }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("unreachable");
      return response.json();
    }).then(data => { if (active) setUser(data.user); })
      .catch(() => { if (active) setError({ key: "connect" }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const changeLanguage = (next: Language) => {
    setLanguage(next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem(languageKey, next); } catch { /* Continue without persistence. */ }
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirmation) { setError({ key: "passwordMismatch" }); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }).catch(() => null);
      if (!response) { setError({ key: "network" }); return; }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError({ key: typeof data?.error === "string" ? data.error : "generic", fallback: typeof data?.message === "string" ? data.message : undefined });
        return;
      }
      if (!data?.user) { setError({ key: "generic" }); return; }
      setPassword(""); setConfirmation(""); setUser(data.user);
    } finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError(null);
    const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    if (!response?.ok) { setError({ key: "signOut" }); setBusy(false); return; }
    // Reload unmounts all account state; a pending local draft stays scoped to its owner.
    window.location.reload();
  }
  if (loading) return <main className="auth-screen"><p role="status">{t.auth.connecting}</p></main>;
  if (user) return <UserContext.Provider value={user}><div className="account-bar"><span>{t.auth.accountLabel}<strong>{user.username}</strong></span><span>{error && <span role="alert">{errorText(error)} </span>}<button type="button" disabled={busy} onClick={signOut}>{busy ? t.auth.signingOut : t.auth.signOut}</button></span></div><div key={user.id}>{children}</div></UserContext.Provider>;
  return <main className="auth-screen"><section className="auth-card">
    <div className="auth-head">
      <div className="auth-brand">ProofFlow <span>{t.auth.brandTagline}</span></div>
      <div className="language-switch" role="group" aria-label={t.language}><Languages size={15} aria-hidden="true" /><button type="button" aria-pressed={language === "zh"} onClick={() => changeLanguage("zh")}>{t.chinese}</button><button type="button" aria-pressed={language === "en"} onClick={() => changeLanguage("en")}>{t.english}</button></div>
    </div>
    <h1>{mode === "login" ? t.auth.welcomeBack : t.auth.createAccount}</h1>
    <p>{t.auth.subtitle}</p>
    <div className="auth-tabs"><button type="button" aria-pressed={mode === "login"} onClick={() => { setMode("login"); setError(null); }}>{t.auth.loginTab}</button><button type="button" aria-pressed={mode === "register"} onClick={() => { setMode("register"); setError(null); }}>{t.auth.registerTab}</button></div>
    <form onSubmit={submit}>
      <label htmlFor="username">{t.auth.username}</label><input id="username" name="username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z0-9_]{3,32}" minLength={3} maxLength={32} required placeholder={t.auth.usernameHint} />
      <label htmlFor="password">{t.auth.password}</label><input id="password" name="password" value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required placeholder={t.auth.passwordHint} />
      {mode === "register" && <><label htmlFor="confirmation">{t.auth.confirmation}</label><input id="confirmation" name="confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></>}
      {error && <p className="auth-error" role="alert">{errorText(error)}</p>}
      <button className="auth-submit" disabled={busy} type="submit">{busy ? t.auth.busy : mode === "login" ? t.auth.submitLogin : t.auth.submitRegister}</button>
    </form><p className="auth-note">{t.auth.note}</p>
  </section></main>;
}
