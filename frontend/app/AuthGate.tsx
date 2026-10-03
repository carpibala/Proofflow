"use client";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
type User = { id: string; username: string };
const UserContext = createContext<User | null>(null);
export function useUser() {
  const user = useContext(UserContext);
  if (!user) throw new Error("Authentication required");
  return user;
}
export function draftStorageKey(userId: string) { return `proofflow-local-draft-v2:${userId}`; }
export default function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("无法连接服务器，请刷新重试");
      return response.json();
    }).then(data => { if (active) setUser(data.user); })
      .catch(error => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "register" && password !== confirmation) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "操作失败，请重试");
      setPassword(""); setConfirmation(""); setUser(data.user);
    } catch (error) { setError(error instanceof Error ? error.message : "网络异常，请重试"); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("退出失败，请重试");
      // Reload unmounts all account state; a pending local draft stays scoped to its owner.
      window.location.reload();
    } catch (error) { setError(error instanceof Error ? error.message : "退出失败"); setBusy(false); }
  }
  if (loading) return <main className="auth-screen"><p role="status">正在连接 ProofFlow…</p></main>;
  if (user) return <UserContext.Provider value={user}><div className="account-bar"><span>ProofFlow 账户 · <strong>{user.username}</strong></span><span>{error && <span role="alert">{error} </span>}<button type="button" disabled={busy} onClick={signOut}>{busy ? "正在退出…" : "退出登录"}</button></span></div><div key={user.id}>{children}</div></UserContext.Provider>;
  return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand">ProofFlow <span>写作过程，清晰可查</span></div>
    <h1>{mode === "login" ? "欢迎回来" : "创建你的账户"}</h1>
    <p>登录后继续写作，文档和操作记录保存到服务器。</p>
    <div className="auth-tabs"><button type="button" aria-pressed={mode === "login"} onClick={() => { setMode("login"); setError(""); }}>登录</button><button type="button" aria-pressed={mode === "register"} onClick={() => { setMode("register"); setError(""); }}>注册</button></div>
    <form onSubmit={submit}>
      <label htmlFor="username">用户名</label><input id="username" name="username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z0-9_]{3,32}" minLength={3} maxLength={32} required placeholder="3–32 位字母、数字或下划线" />
      <label htmlFor="password">密码</label><input id="password" name="password" value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required placeholder="至少 8 个字符" />
      {mode === "register" && <><label htmlFor="confirmation">确认密码</label><input id="confirmation" name="confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" disabled={busy} type="submit">{busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}</button>
    </form><p className="auth-note">用户名不区分大小写。请妥善保存密码，此版本暂不提供密码找回。</p>
  </section></main>;
}
