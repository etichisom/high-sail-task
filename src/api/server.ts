// The HTTP API: upload manuals, list them, ask questions. Plain node:http, no framework.
// Uploads are only queued here; the worker (npm run worker) does the ingest work.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { ask } from "../answer/ask.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { findOrCreateTenant, findTenant } from "../tenants.js";
import { savePdfUpload, saveZipUpload, UploadError, type UploadResult } from "./upload.js";

const MB = 1024 * 1024;
const MAX_QUESTION_CHARS = 2000;

// An error with the HTTP status to send back
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// WHO IS CALLING. For now the caller names the company in the X-Tenant header, because there is no login yet.
// When login exists, this function reads the session cookie instead and finds the company from the user.
// The company must NEVER come from the request body or the URL: a caller could change those to any company.
async function tenantFromRequest(req: IncomingMessage, options: { create?: boolean } = {}): Promise<string> {
  const header = req.headers["x-tenant"];
  const name = typeof header === "string" ? header.trim() : "";
  if (name === "") throw new HttpError(400, "send the company name in the X-Tenant header");
  if (options.create) return findOrCreateTenant(name);
  const id = await findTenant(name);
  if (!id) throw new HttpError(404, `no company called "${name}"`);
  return id;
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

async function uploadDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenantId = await tenantFromRequest(req, { create: true });
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

async function askQuestion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenantId = await tenantFromRequest(req);
  const body = await readJson(req, 64 * 1024);
  const question = typeof body === "object" && body !== null ? (body as { question?: unknown }).question : undefined;
  if (typeof question !== "string" || question.trim() === "") {
    throw new HttpError(400, 'send {"question": "..."}');
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new HttpError(400, `the question is longer than ${MAX_QUESTION_CHARS} characters`);
  }
  send(res, 200, await ask(tenantId, question.trim()));
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
