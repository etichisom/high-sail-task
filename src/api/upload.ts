// Saves uploaded PDFs and ZIP files of PDFs for one company, and queues them for the worker.
// Nothing here runs Docling or Claude: the upload only stores the file and adds a 'queued' row.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { pool } from "../db.js";

export type UploadResult = {
  filename: string;
  status: "queued" | "duplicate" | "rejected";
  reason?: string;
};

// A problem with the whole upload (for example a file that is not a ZIP). The server answers 400.
export class UploadError extends Error {}

const MB = 1024 * 1024;
const execFileAsync = promisify(execFile);

// A PDF upload: the file is the same bytes as one already saved for this company → 'duplicate', nothing new.
export async function savePdfUpload(tenantId: string, filename: string, bytes: Buffer): Promise<UploadResult> {
  return storePdf(tenantId, safeName(filename), bytes);
}

// A ZIP upload: every PDF inside is saved like a PDF upload. Other files are reported and skipped.
export async function saveZipUpload(tenantId: string, filename: string, bytes: Buffer): Promise<UploadResult[]> {
  // unzip only reads files from disk, so the ZIP is written to a private folder first, removed afterwards
  const dir = await mkdtemp(join(tmpdir(), "ask-zip-"));
  try {
    const zipPath = join(dir, "upload.zip");
    await writeFile(zipPath, bytes, { mode: 0o600 });
    return await savePdfsFromZip(tenantId, zipPath, safeName(filename));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function savePdfsFromZip(tenantId: string, zipPath: string, zipName: string): Promise<UploadResult[]> {
  let entries: string[];
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath], { maxBuffer: 16 * MB });
    entries = stdout.split("\n").filter((line) => line.length > 0);
  } catch {
    throw new UploadError(`${zipName} is not a valid ZIP file`);
  }

  const results: UploadResult[] = [];
  let pdfCount = 0;
  let totalBytes = 0;
  let totalFull = false; // once the total is over the limit, the rest of the PDFs are rejected without reading them

  for (const entry of entries) {
    if (entry.endsWith("/")) continue; // a folder, not a file

    const name = basename(entry);
    const unsafe = unsafeEntryReason(entry);
    if (unsafe) {
      results.push({ filename: entry, status: "rejected", reason: unsafe });
      continue;
    }
    if (!/\.pdf$/i.test(entry)) {
      results.push({ filename: entry, status: "rejected", reason: "not a PDF (only .pdf files are taken from a ZIP)" });
      continue;
    }
    if (pdfCount >= config.zipMaxPdfs) {
      results.push({ filename: entry, status: "rejected", reason: `more than ${config.zipMaxPdfs} PDFs in one ZIP` });
      continue;
    }
    pdfCount++;
    if (totalFull) {
      results.push({ filename: entry, status: "rejected", reason: `ZIP holds more than ${config.zipMaxTotalMb} MB of PDFs` });
      continue;
    }

    let bytes: Buffer;
    try {
      // maxBuffer stops unzip early: a PDF bigger than the limit is never read into memory in full
      const maxBytes = config.zipMaxPdfMb * MB;
      const { stdout } = await execFileAsync("unzip", ["-p", zipPath, entry], {
        encoding: "buffer",
        maxBuffer: maxBytes + 1,
      });
      bytes = stdout as unknown as Buffer;
    } catch (error) {
      const tooBig = (error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      results.push({
        filename: name,
        status: "rejected",
        reason: tooBig ? `larger than ${config.zipMaxPdfMb} MB` : "could not be read from the ZIP",
      });
      continue;
    }

    totalBytes += bytes.length;
    if (totalBytes > config.zipMaxTotalMb * MB) {
      totalFull = true;
      results.push({ filename: name, status: "rejected", reason: `ZIP holds more than ${config.zipMaxTotalMb} MB of PDFs` });
      continue;
    }
    results.push(await storePdf(tenantId, name, bytes));
  }
  return results;
}

// Names that could trick the extraction are refused. unzip treats * ? [ ] as patterns, and a name starting
// with "-" could be read as an option, so those are refused too.
function unsafeEntryReason(entry: string): string | null {
  if (entry.includes("..") || entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    return "unsafe path in ZIP";
  }
  if (/[\u0000-\u001f*?[\]]/.test(entry) || entry.startsWith("-")) {
    return "unsupported characters in file name";
  }
  return null;
}

// The one place a PDF's bytes become a document row. Used by both upload kinds.
async function storePdf(tenantId: string, filename: string, bytes: Buffer): Promise<UploadResult> {
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    return { filename, status: "rejected", reason: "not a PDF file" };
  }

  const hash = createHash("sha256").update(bytes).digest("hex");
  const uploadsDir = join(config.storeDir, "uploads");
  const target = join(uploadsDir, `${hash}.pdf`);
  if (!existsSync(target)) {
    // Write to a temp name, then rename: the worker never sees a half-written file
    await mkdir(uploadsDir, { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`; // unique, so two uploads of the same file cannot collide
    await writeFile(temp, bytes);
    await rename(temp, target);
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, filename, file_hash, status)
     VALUES ($1, $2, $3, 'queued')
     ON CONFLICT (tenant_id, file_hash) DO NOTHING
     RETURNING id`,
    [tenantId, filename, hash],
  );
  if (inserted.rows[0]) return { filename, status: "queued" };

  // The same file is already here. If its earlier attempt failed, try again; otherwise it is a duplicate.
  const retried = await pool.query<{ id: string }>(
    `UPDATE documents SET status = 'queued', progress = NULL, error = NULL
     WHERE tenant_id = $1 AND file_hash = $2 AND status = 'failed'
     RETURNING id`,
    [tenantId, hash],
  );
  if (retried.rows[0]) return { filename, status: "queued", reason: "earlier attempt failed, trying again" };
  return { filename, status: "duplicate", reason: "this company already has this file" };
}

// Keep only the last part of the name: browsers and some clients send "C:\\docs\\x.pdf" or "folder/x.pdf"
function safeName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  return (last.trim() || "upload").slice(0, 255);
}
