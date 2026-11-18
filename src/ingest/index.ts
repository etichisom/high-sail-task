// The ingest pipeline for one PDF: Docling → chunks → Postgres.
// The CLI uses it now; the background worker will use the exact same function later.
import { basename } from "node:path";
import { pool } from "../db.js";
import { chunkDocument } from "./chunk.js";
import { convertPdf, fileHash } from "./docling.js";
import { pagesNeedingVision, type VisionPage } from "./needs-vision.js";

export type IngestResult =
  | { status: "skipped"; documentId: string }
  | { status: "ready"; documentId: string; pages: number; chunks: number; visionPages: VisionPage[] };

export async function ingestDocument(tenantId: string, pdfPath: string): Promise<IngestResult> {
  const filename = basename(pdfPath);
  const hash = fileHash(pdfPath);

  // 1. Same file already processed for this company? Then there is nothing to do.
  const existing = await pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM documents WHERE tenant_id = $1 AND file_hash = $2",
    [tenantId, hash],
  );
  if (existing.rows[0]?.status === "ready") {
    return { status: "skipped", documentId: existing.rows[0].id };
  }

  // 2. Create the document row (or reuse it after an earlier failure)
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, filename, file_hash, status)
     VALUES ($1, $2, $3, 'processing')
     ON CONFLICT (tenant_id, file_hash) DO UPDATE SET status = 'processing', error = NULL
     RETURNING id`,
    [tenantId, filename, hash],
  );
  const documentId = rows[0]!.id;

  try {
    // 3. PDF → Docling JSON → chunks, and which pages need vision (used in step 8.6)
    const doc = await convertPdf(pdfPath);
    const chunks = chunkDocument(doc);
    const visionPages = pagesNeedingVision(doc);
    const pageCount = Object.keys(doc.pages).length;

    // 4. Save everything in one transaction: either all chunks are stored, or none
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);
      // Every chunk starts with the manual's name ("midea-r290-mono-4-16kw-installation-en"), so a question
      // that names the brand or model can match a table row that never mentions it (same as vision chunks)
      const manual = basename(pdfPath, ".pdf");
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO chunks (tenant_id, document_id, page_start, page_end, chunk_type, section, source, content)
           VALUES ($1, $2, $3, $4, $5, $6, 'docling', $7)`,
          [tenantId, documentId, chunk.pageStart, chunk.pageEnd, chunk.chunkType, chunk.section, `${manual}\n\n${chunk.content}`],
        );
      }
      await client.query(
        "UPDATE documents SET status = 'ready', page_count = $2, progress = NULL WHERE id = $1",
        [documentId, pageCount],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return { status: "ready", documentId, pages: pageCount, chunks: chunks.length, visionPages };
  } catch (error) {
    // 5. Remember what went wrong, so the web app can show it later
    await pool.query("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [documentId, String(error)]);
    throw error;
  }
}