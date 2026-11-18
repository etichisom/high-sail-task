// The background worker: takes queued PDFs one at a time and runs the full ingest pipeline on each.
// Run it as many times as you like (npm run worker): SKIP LOCKED means two workers never take the same document.
import { join } from "node:path";
import pg from "pg";
import { config } from "../config.js";
import { pool } from "../db.js";
import { processDocument } from "../ingest/pipeline.js";

type Queued = { id: string; tenant_id: string; file_hash: string; filename: string };

// Why an advisory lock and not a "stuck for 30 minutes" timestamp: the documents table has no time of
// the last change, and we do not change the schema for this. While a worker works on a document it holds
// a Postgres advisory lock on its own connection. If the worker crashes, Postgres drops that lock, so at
// the next start a 'processing' document whose lock is free has no worker behind it: it goes back to the queue.
const lockKey = "hashtextextended($1, 0)";

// Ctrl+C: finish the current document, then stop. A second Ctrl+C stops at once; the document then
// stays 'processing' and the next worker start re-queues it.
let stopping = false;
let wakeUp: (() => void) | null = null;
function askToStop() {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("[worker] stopping after the current document (Ctrl+C again to stop now)");
  wakeUp?.();
}
process.on("SIGINT", askToStop);
process.on("SIGTERM", askToStop);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    }
    wakeUp = done;
  });
}

// Take the oldest queued document. FOR UPDATE SKIP LOCKED: another worker's row is skipped, not waited for.
async function claimNext(): Promise<Queued | undefined> {
  const { rows } = await pool.query<Queued>(
    `UPDATE documents SET status = 'processing'
     WHERE id = (SELECT id FROM documents WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, tenant_id, file_hash, filename`,
  );
  return rows[0];
}

// Documents a crashed worker left in 'processing' go back to the queue
async function requeueAbandoned(lock: pg.Client): Promise<void> {
  const { rows } = await pool.query<{ id: string; filename: string }>(
    "SELECT id, filename FROM documents WHERE status = 'processing'",
  );
  for (const row of rows) {
    const got = await lock.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${lockKey}) AS locked`, [row.id]);
    if (!got.rows[0]?.locked) continue; // a live worker holds it: leave it alone
    await pool.query("UPDATE documents SET status = 'queued', progress = NULL WHERE id = $1 AND status = 'processing'", [
      row.id,
    ]);
    await lock.query(`SELECT pg_advisory_unlock(${lockKey})`, [row.id]);
    console.log(`[worker] ${row.filename}: was left 'processing' by a stopped worker, queued again`);
  }
}

async function run(doc: Queued, lock: pg.Client): Promise<void> {
  // The file the API saved; its name is its sha256, so the worker finds it from the row alone
  const pdfPath = join(config.storeDir, "uploads", `${doc.file_hash}.pdf`);
  await lock.query(`SELECT pg_advisory_lock(${lockKey})`, [doc.id]);
  console.log(`[worker] ${doc.filename}: start`);
  try {
    const result = await processDocument(doc.tenant_id, pdfPath, (message) =>
      console.log(`[worker] ${doc.filename}: ${message}`),
    );
    if (result.status === "skipped") {
      console.log(`[worker] ${doc.filename}: already ready, skipped`);
    } else {
      console.log(
        `[worker] ${doc.filename}: ready (${result.pages} pages, ${result.chunks} chunks, ${result.visionAdded} vision chunks, ${result.embedded} embeddings)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // processDocument marks the row failed itself; this covers errors before it could (e.g. the PDF file is missing)
    await pool.query("UPDATE documents SET status = 'failed', progress = NULL, error = $2 WHERE id = $1 AND status = 'processing'", [
      doc.id,
      message,
    ]);
    console.error(`[worker] ${doc.filename}: FAILED - ${message}`);
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(${lockKey})`, [doc.id]);
  }
}

async function main(): Promise<void> {
  const lock = new pg.Client({ connectionString: config.databaseUrl });
  await lock.connect();
  console.log(`[worker] started, checking the queue every ${config.workerPollSeconds} s`);

  await requeueAbandoned(lock);
  while (!stopping) {
    const doc = await claimNext();
    if (!doc) {
      await sleep(config.workerPollSeconds * 1000);
      continue;
    }
    await run(doc, lock);
  }

  await lock.end();
  await pool.end();
  console.log("[worker] stopped");
}

await main();
