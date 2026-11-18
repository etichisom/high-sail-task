// The HTTP API: upload manuals, list them, ask questions. Plain node:http, no framework.
// Uploads are only queued here; the worker (npm run worker) does the ingest work.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { ask } from "../answer/ask.js";
import {
  conversationMessages,
  createConversation,
  deleteConversation,
  listConversations,
  ownConversation,
  recentTurns,
  saveTurn,
} from "../chat/conversations.js";
import { AccountError, logIn, signUp } from "../auth/accounts.js";
import { createSession, deleteSession, findSession, type SessionUser } from "../auth/sessions.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { findTenant } from "../tenants.js";
import { savePdfUpload, saveZipUpload, UploadError, type UploadResult } from "./upload.js";

const MB = 1024 * 1024;
const MAX_QUESTION_CHARS = 2000;
const SESSION_COOKIE = "session";

// The web app: the React build in web/dist (cd web && npm run build). Files are served only from inside
// that folder: the resolved path must stay in it, so a request like /../package.json cannot escape.
const WEB_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // failures are counted over 15 minutes
const LOGIN_MAX_FAILURES = 10; // after this many failed logins for one email, that email is refused for the window

// An error with the HTTP status to send back
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Reads one cookie from the Cookie header. Done by hand so no cookie package is needed.
// The values here are ids, so no URL decoding is needed.
function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function currentSession(req: IncomingMessage): Promise<SessionUser | null> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  return sessionId ? findSession(sessionId) : null;
}

// WHO IS CALLING. The company comes from the session cookie, found on the server.
// The company must NEVER come from the request body or the URL: a caller could change those to any company.
async function tenantFromRequest(req: IncomingMessage): Promise<string> {
  const session = await currentSession(req);
  if (session) return session.tenantId;

  // DEVELOPMENT ONLY: with ALLOW_TENANT_HEADER=true, the X-Tenant header names the company, so local curl tests
  // and scripts still work. It must stay off when the API is hosted, or anyone could pick any company.
  if (config.allowTenantHeader) {
    const header = req.headers["x-tenant"];
    const name = typeof header === "string" ? header.trim() : "";
    if (name !== "") {
      const id = await findTenant(name);
      if (!id) throw new HttpError(404, `no company called "${name}"`);
      return id;
    }
  }
  throw new HttpError(401, "please log in");
}

// Cookie flags. HttpOnly hides the cookie from page scripts. SameSite=Lax stops most cross-site form posts.
// Secure (COOKIE_SECURE=true) sends the cookie only over HTTPS, so turn it on when hosted.
function cookieAttributes(maxAgeSeconds: number): string {
  const parts = ["HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(res: ServerResponse, sessionId: string): void {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${sessionId}; ${cookieAttributes(config.sessionDays * 24 * 60 * 60)}`);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=; ${cookieAttributes(0)}`);
}

// Failed logins per email, in memory. The list holds the times of recent failures.
// It resets when the API restarts and is not shared between several API processes.
// A real deployment would keep this in Redis or the database.
const failedLogins = new Map<string, number[]>();

function recentFailures(email: string): number[] {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const recent = (failedLogins.get(email) ?? []).filter((time) => time > cutoff);
  if (recent.length > 0) failedLogins.set(email, recent);
  else failedLogins.delete(email);
  return recent;
}

function isLoginLocked(email: string): boolean {
  return recentFailures(email).length >= LOGIN_MAX_FAILURES;
}

function recordFailedLogin(email: string): void {
  failedLogins.set(email, [...recentFailures(email), Date.now()]);
}

function clearFailedLogins(email: string): void {
  failedLogins.delete(email);
}

// Reads one text field from a parsed JSON body. Anything that is not text becomes "", which then fails validation.
function textField(body: unknown, name: string): string {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : "";
}

// Reads a multipart body. The size is counted while it arrives, so a too-big upload is stopped early
// instead of being buffered. formData() does the multipart parsing (no extra package needed).
async function readUpload(req: IncomingMessage, maxBytes: number): Promise<FormData> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw tooLarge(maxBytes);

  let overLimit = false;
  async function* limited(): AsyncGenerator<Buffer> {
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        overLimit = true;
        throw new Error("upload too large");
      }
      yield chunk as Buffer;
    }
  }

  const request = new Request(`http://localhost${req.url ?? "/"}`, {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] ?? "" },
    body: Readable.toWeb(Readable.from(limited())) as ReadableStream,
    duplex: "half", // needed by fetch when the body is a stream
  } as RequestInit);
  try {
    return await request.formData();
  } catch {
    if (overLimit) throw tooLarge(maxBytes);
    throw new HttpError(400, 'send the file as multipart/form-data in a field called "file"');
  }
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, `file is larger than ${Math.round(maxBytes / MB)} MB`);
}

// Reads a small JSON body (the question). Capped, so nobody can send a huge body.
async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "the body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function signUpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, 16 * 1024);
  let user: SessionUser;
  try {
    user = await signUp(textField(body, "company"), textField(body, "email"), textField(body, "password"));
  } catch (error) {
    if (error instanceof AccountError) throw new HttpError(error.status, error.message);
    throw error;
  }
  setSessionCookie(res, await createSession(user.userId));
  send(res, 201, { email: user.email, company: user.company });
}

async function logInHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, 16 * 1024);
  const email = textField(body, "email").trim().toLowerCase();
  const password = textField(body, "password");
  if (email === "" || password === "") throw new HttpError(400, 'send {"email": "...", "password": "..."}');

  // Checked before the password, so a locked email is refused even with the right password.
  if (isLoginLocked(email)) throw new HttpError(429, "too many failed logins, try again in 15 minutes");
  const user = await logIn(email, password);
  if (!user) {
    recordFailedLogin(email);
    throw new HttpError(401, "wrong email or password");
  }
  clearFailedLogins(email);
  setSessionCookie(res, await createSession(user.userId));
  send(res, 200, { email: user.email, company: user.company });
}

async function logOutHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(res);
  send(res, 200, { ok: true });
}

async function meHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = await currentSession(req);
  if (!session) throw new HttpError(401, "please log in");
  send(res, 200, { email: session.email, company: session.company });
}

async function uploadDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenantId = await tenantFromRequest(req);
  const form = await readUpload(req, config.maxUploadMb * MB);

  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, 'send a file in a form field called "file"');
  const bytes = Buffer.from(await file.arrayBuffer());
  const lower = file.name.toLowerCase();

  let results: UploadResult[];
  try {
    if (lower.endsWith(".pdf")) results = [await savePdfUpload(tenantId, file.name, bytes)];
    else if (lower.endsWith(".zip")) results = await saveZipUpload(tenantId, file.name, bytes);
    else throw new HttpError(400, "only .pdf and .zip files are accepted");
  } catch (error) {
    if (error instanceof UploadError) throw new HttpError(400, error.message);
    throw error;
  }

  if (results.length === 0) throw new HttpError(400, "the ZIP has no PDF files");
  const accepted = results.filter((r) => r.status !== "rejected");
  if (accepted.length === 0) return send(res, 400, { error: "no file was accepted", results });
  const anyQueued = accepted.some((r) => r.status === "queued");
  send(res, anyQueued ? 202 : 200, { results }); // 202: queued for the worker, 200: only duplicates
}

async function listDocuments(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenantId = await tenantFromRequest(req);
  const { rows } = await pool.query(
    `SELECT id, filename, status, progress, error, page_count, created_at
     FROM documents WHERE tenant_id = $1 ORDER BY created_at, filename`,
    [tenantId],
  );
  send(res, 200, { documents: rows });
}

// Reads and checks the question from the body. Shared by POST /ask and POST /ask/stream.
// "conversationId" is optional: leave it out to start a new chat, send it to ask a follow-up.
async function readQuestion(req: IncomingMessage): Promise<{ question: string; conversationId: string }> {
  const body = await readJson(req, 64 * 1024);
  const question = textField(body, "question");
  if (question.trim() === "") throw new HttpError(400, 'send {"question": "..."}');
  if (question.length > MAX_QUESTION_CHARS) {
    throw new HttpError(400, `the question is longer than ${MAX_QUESTION_CHARS} characters`);
  }
  return { question: question.trim(), conversationId: textField(body, "conversationId") };
}

// Finds (or starts) the chat a question belongs to. Only for a logged-in user: with the dev X-Tenant header
// there is no user, so nothing is saved. A conversationId of another user is refused (404).
async function chatFor(
  req: IncomingMessage,
  tenantId: string,
  question: string,
  conversationId: string,
): Promise<{ id: string; history: Awaited<ReturnType<typeof recentTurns>> } | null> {
  const session = await currentSession(req);
  if (!session) return null;
  if (conversationId === "") return { id: await createConversation(tenantId, session.userId, question), history: [] };
  const id = await ownConversation(tenantId, session.userId, conversationId);
  if (!id) throw new HttpError(404, "no such conversation");
  return { id, history: await recentTurns(tenantId, id) };
}

async function askQuestion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenantId = await tenantFromRequest(req);
  const { question, conversationId } = await readQuestion(req);
  const chat = await chatFor(req, tenantId, question, conversationId);
  const result = await ask(tenantId, question, undefined, chat?.history ?? []);
  if (chat) await saveTurn(tenantId, chat.id, question, result);
  send(res, 200, { ...result, conversationId: chat?.id ?? null });
}

// POST /ask/stream: the same question as POST /ask, but the answer comes as Server-Sent Events.
// "progress" events show each step while it runs; the finished answer comes as one "answer" event.
// If something fails after the stream has started, an "error" event is sent instead.
// Problems before the stream starts (not logged in, bad body) are normal JSON errors from the route.
async function askStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenantId = await tenantFromRequest(req);
  const { question, conversationId } = await readQuestion(req);
  const chat = await chatFor(req, tenantId, question, conversationId);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache", // a cached copy would replay old steps
    connection: "keep-alive",
    "x-accel-buffering": "no", // tells nginx-style proxies not to hold the events back
  });

  // One SSE message. JSON.stringify never puts a newline inside the data, so one "data:" line is enough.
  const sendEvent = (name: string, data: unknown): void => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    if (chat) sendEvent("conversation", { id: chat.id });
    // Pieces of the answer text go out as "delta" events, the steps as "progress" events
    const result = await ask(
      tenantId,
      question,
      (event) => {
        if (event.type === "answer_delta") sendEvent("delta", { text: event.text });
        else if (event.type === "answer_reset") sendEvent("reset", {});
        else sendEvent("progress", event);
      },
      chat?.history ?? [],
    );
    if (chat) await saveTurn(tenantId, chat.id, question, result);
    sendEvent("answer", { ...result, conversationId: chat?.id ?? null });
  } catch (error) {
    // The details stay in the server log; the browser gets a plain message
    console.error("[api] ask/stream failed:", error);
    sendEvent("error", { error: "could not answer the question, please try again" });
  } finally {
    res.end();
  }
}

// GET /conversations: the logged-in user's chats. GET/DELETE /conversations/<id>: one chat.
async function conversationsRoute(req: IncomingMessage, res: ServerResponse, id: string | null, method: string): Promise<void> {
  const session = await currentSession(req);
  if (!session) throw new HttpError(401, "please log in");
  if (id === null) {
    if (method !== "GET") throw new HttpError(405, "use GET");
    return send(res, 200, { conversations: await listConversations(session.tenantId, session.userId) });
  }
  if (method === "GET") {
    const messages = await conversationMessages(session.tenantId, session.userId, id);
    if (!messages) throw new HttpError(404, "no such conversation");
    return send(res, 200, { id, messages });
  }
  if (method === "DELETE") {
    if (!(await deleteConversation(session.tenantId, session.userId, id))) throw new HttpError(404, "no such conversation");
    return send(res, 200, { ok: true });
  }
  throw new HttpError(405, "use GET or DELETE");
}

// GET for the web app. Built files (/assets/...) are cached for a year: their names change with every build.
// Any other path gets index.html, so a reload on a page of the app still works.
async function sendWebFile(res: ServerResponse, pathname: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "bad path");
  }
  let file = resolve(WEB_DIR, "." + decoded);
  if (!file.startsWith(WEB_DIR) || !(await isFile(file))) file = join(WEB_DIR, "index.html");
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpError(404, "the web app is not built yet: run `npm run build` in web/");
  }
  const immutable = file.startsWith(join(WEB_DIR, "assets"));
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (url.pathname === "/health") {
    if (method !== "GET") throw new HttpError(405, "use GET");
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/documents") {
    if (method === "GET") return listDocuments(req, res);
    if (method === "POST") return uploadDocument(req, res);
    throw new HttpError(405, "use GET or POST");
  }
  if (url.pathname === "/ask") {
    if (method !== "POST") throw new HttpError(405, "use POST");
    return askQuestion(req, res);
  }
  if (url.pathname === "/ask/stream") {
    if (method !== "POST") throw new HttpError(405, "use POST");
    return askStream(req, res);
  }
  if (url.pathname === "/conversations") return conversationsRoute(req, res, null, method);
  if (url.pathname.startsWith("/conversations/")) {
    return conversationsRoute(req, res, url.pathname.slice("/conversations/".length), method);
  }
  if (url.pathname === "/auth/signup") {
    if (method !== "POST") throw new HttpError(405, "use POST");
    return signUpHandler(req, res);
  }
  if (url.pathname === "/auth/login") {
    if (method !== "POST") throw new HttpError(405, "use POST");
    return logInHandler(req, res);
  }
  if (url.pathname === "/auth/logout") {
    if (method !== "POST") throw new HttpError(405, "use POST");
    return logOutHandler(req, res);
  }
  if (url.pathname === "/me") {
    if (method !== "GET") throw new HttpError(405, "use GET");
    return meHandler(req, res);
  }
  if (method === "GET") return sendWebFile(res, url.pathname);
  throw new HttpError(404, "not found");
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 413) res.setHeader("connection", "close"); // the rest of the body is not read
      return send(res, error.status, { error: error.message });
    }
    console.error("[api] internal error:", error);
    send(res, 500, { error: "internal error" });
  }
});

server.listen(config.apiPort, () => {
  console.log(`[api] listening on http://localhost:${config.apiPort}`);
});

// Ctrl+C: stop taking new requests, let the open ones finish. A second Ctrl+C stops at once.
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("[api] stopping");
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  server.closeIdleConnections();
});
