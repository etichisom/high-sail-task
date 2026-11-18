// Add a vision chunk for every flagged page of one ingested PDF (Docling's chunks stay as they are).
// Pages that already have a vision chunk are skipped, so running it again only does new work.
import { pool } from "../db.js";
import { config } from "../config.js";
import { convertPdf, fileHash } from "./docling.js";
import { pagesNeedingVision } from "./needs-vision.js";
import { readPage } from "./vision.js";

export type VisionResult = { pages: number; added: number; costUsd: number; failed: string[] };

export async function addVisionChunks(
  tenantId: string,
  pdfPath: string,
  onPage?: (page: number, cached: boolean) => void, // lets the CLI show progress
): Promise<VisionResult> {
  const hash = fileHash(pdfPath);
  const found = await pool.query<{ id: string }>(
    "SELECT id FROM documents WHERE tenant_id = $1 AND file_hash = $2 AND status = 'ready'",
    [tenantId, hash],
  );
  const documentId = found.rows[0]?.id;
  if (!documentId) throw new Error("not ingested for this company yet (run ingest first)");

  const flagged = pagesNeedingVision(await convertPdf(pdfPath)).map((p) => p.page);
  const done = await pool.query<{ page_start: number }>(
    "SELECT page_start FROM chunks WHERE tenant_id = $1 AND document_id = $2 AND source = 'vision'",
    [tenantId, documentId],
  );
  const alreadyDone = new Set(done.rows.map((row) => row.page_start));
  const todo = flagged.filter((page) => !alreadyDone.has(page));

  const result: VisionResult = { pages: flagged.length, added: 0, costUsd: 0, failed: [] };

  // A few pages at the same time: each call waits ~10 s for Claude, so 4 in parallel is ~4× faster
  const queue = [...todo];
  async function worker() {
    for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
      try {
        const { text, costUsd, cached } = await readPage(pdfPath, hash, page);
        await pool.query(
          `INSERT INTO chunks (tenant_id, document_id, page_start, page_end, chunk_type, source, content)
           VALUES ($1, $2, $3, $3, 'page', 'vision', $4)`,
          [tenantId, documentId, page, text],
        );
        result.added++;
        result.costUsd += costUsd ?? 0;
        onPage?.(page, cached);
      } catch (error) {
        // One bad page must not stop the rest; the next run retries it
        result.failed.push(`p${page}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: config.visionConcurrency }, worker));
  return result;
}
