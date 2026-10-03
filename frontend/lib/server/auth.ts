import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { ApiError, db } from "./provenance";

export type User = { id: string; username: string };
const cookieName = "proofflow_session";
const lifetime = 7 * 24 * 60 * 60;
function database() {
  const connection = db();
  connection.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS auth_attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
  return connection;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export function checkOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const expected = process.env.PROOFFLOW_ORIGIN ?? new URL(request.url).origin;
  // JSON-only mutations plus exact Origin checking prevent browser cross-site form submissions.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      (request.headers.has("origin") && request.headers.get("origin") !== expected) ||
      request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "INVALID_ORIGIN", "请求来源不受信任");
  }
}
function token(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function currentUser(request: Request): User | null {
  const value = token(request);
  if (!value) return null;
  return database().prepare(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(digest(value), Date.now()) as User | undefined ?? null;
}
export function requireUser(request: Request): User {
  checkOrigin(request);
  const user = currentUser(request);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "请先登录，登录后可重试保存");
  return user;
}
export function requireDocument(request: Request, id: string): User {
  const user = requireUser(request);
  if (!database().prepare("SELECT id FROM documents WHERE id = ? AND owner_id = ?").get(id, user.id)) {
    throw new ApiError(404, "NOT_FOUND", "文档不存在或无权访问");
  }
  return user;
}
export function listDocuments(userId: string) {
  return database().prepare("SELECT id, title, version, status, updated_at AS updatedAt FROM documents WHERE owner_id = ? ORDER BY updated_at DESC").all(userId);
}
function cookie(value: string, maxAge: number) {
  const secure = process.env.PROOFFLOW_COOKIE_SECURE === "true" ||
    (process.env.PROOFFLOW_COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production");
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function throttle(bucket: string, limit: number) {
  const connection = database();
  const now = Date.now();
  connection.prepare("DELETE FROM auth_attempts WHERE reset_at <= ?").run(now);
  const row = connection.prepare(`INSERT INTO auth_attempts(bucket,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count`).get(bucket, now + 15 * 60 * 1000) as { count: number };
  if (row.count > limit) throw new ApiError(429, "RATE_LIMITED", "尝试过于频繁，请在 15 分钟后重试");
}
export async function authenticate(input: unknown, register: boolean, request: Request) {
  checkOrigin(request);
  if (!input || typeof input !== "object") throw new ApiError(400, "INVALID_CREDENTIALS", "请输入用户名和密码");
  const { username: raw, password } = input as { username?: unknown; password?: unknown };
  if (typeof raw !== "string" || !/^[a-zA-Z0-9_]{3,32}$/.test(raw) || typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new ApiError(400, "INVALID_CREDENTIALS", "用户名须为 3–32 位字母、数字或下划线；密码须为 8–128 个字符");
  }
  const username = raw.toLowerCase();
  throttle("global-auth", 200);
  throttle(`${register ? "register" : "login"}:${username}`, 10);
  const connection = database();
  let user: User;
  if (register) {
    const salt = randomBytes(16).toString("hex");
    const hash = `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
    user = { id: randomUUID(), username };
    const result = connection.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES (?,?,?,?) ON CONFLICT(username) DO NOTHING")
      .run(user.id, username, hash, new Date().toISOString());
    if (!result.changes) throw new ApiError(409, "USERNAME_TAKEN", "该用户名已注册");
  } else {
    const row = connection.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username) as (User & { password_hash: string }) | undefined;
    const parts = row?.password_hash.split("$");
    const key = await derive(password, parts?.[1] ?? "00000000000000000000000000000000");
    const expected = Buffer.from(parts?.[2] ?? "00".repeat(64), "hex");
    if (!row || expected.length !== key.length || !timingSafeEqual(key, expected)) throw new ApiError(401, "LOGIN_FAILED", "用户名或密码错误");
    user = { id: row.id, username: row.username };
    connection.prepare("DELETE FROM auth_attempts WHERE bucket = ?").run(`login:${username}`);
  }
  const old = token(request);
  if (old) connection.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(old));
  connection.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  const value = randomBytes(32).toString("hex");
  connection.prepare("INSERT INTO sessions VALUES (?,?,?)").run(digest(value), user.id, Date.now() + lifetime * 1000);
  return Response.json({ user }, { status: register ? 201 : 200, headers: { "Set-Cookie": cookie(value, lifetime), "Cache-Control": "no-store" } });
}
export function logout(request: Request) {
  checkOrigin(request);
  const value = token(request);
  if (value) database().prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(value));
  return Response.json({ success: true }, { headers: { "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" } });
}
