// The whole ingest for one PDF, in order: Docling → chunks → vision pages → embeddings.
// The document becomes 'ready' only after every step worked. Any error sets it 'failed' with the message.
import { pool } from "../db.js";
import { embedChunks } from "./embed-chunks.js";
import { fileHash } from "./docling.js";
import { ingestDocument } from "./index.js";
import { addVisionChunks } from "./vision-chunks.js";

export type PipelineResult =
  | { status: "skipped"; documentId: string } // this file is already ready for this company
  | { status: "ready"; documentId: string; pages: number; chunks: number; visionAdded: number; embedded: number };

// onProgress gets one line per step (the worker prints them); progress also goes to documents.progress
export async function processDocument(
  tenantId: string,
  pdfPath: string,
  onProgress?: (message: string) => void,
): Promise<PipelineResult> {
  let hash = ""; // filled in first thing, below; the catch block needs it to mark the document failed
  // Steps run one after another, so progress writes must too: a late "page 3" must not overwrite "embedding"
  let progressWrites: Promise<void> = Promise.resolve();
  const setProgress = (message: string) => {
    onProgress?.(message);
    progressWrites = progressWrites.then(() => saveProgress(tenantId, hash, message));
  };

  try {
    hash = fileHash(pdfPath);

    setProgress("converting");
    const stored = await ingestDocument(tenantId, pdfPath, { markReady: false });
    if (stored.status === "skipped") {
      // Already fully processed earlier: the worker set it 'processing' when it took the job, so put it back
      await pool.query("UPDATE documents SET status = 'ready', progress = NULL WHERE id = $1 AND tenant_id = $2", [
        stored.documentId,
        tenantId,
      ]);
      return { status: "skipped", documentId: stored.documentId };
    }

    setProgress("reading pages with vision");
    let pagesRead = 0;
    const vision = await addVisionChunks(tenantId, pdfPath, () => {
      pagesRead++;
      setProgress(`reading pages with vision: ${pagesRead} done`);
    });
    await progressWrites;
    // addVisionChunks keeps going when one page fails. The document must not be ready with a missing page.
    if (vision.failed.length > 0) {
      throw new Error(`vision failed on ${vision.failed.length} page(s): ${vision.failed.slice(0, 3).join("; ")}`);
    }

    setProgress("embedding");
    const embedded = await embedChunks(tenantId, (done) => setProgress(`embedding: ${done} chunks done`));
    await progressWrites;

    await pool.query(
      "UPDATE documents SET status = 'ready', progress = NULL, error = NULL WHERE id = $1 AND tenant_id = $2",
      [stored.documentId, tenantId],
    );
    return {
      status: "ready",
      documentId: stored.documentId,
      pages: stored.pages,
      chunks: stored.chunks,
      visionAdded: vision.added,
      embedded,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await progressWrites.catch(() => {}); // let any pending progress line land first, so it cannot overwrite 'failed'
    if (hash) {
      // The ingest step may already have marked it failed; this also covers the later steps
      await pool.query(
        "UPDATE documents SET status = 'failed', progress = NULL, error = $3 WHERE tenant_id = $1 AND file_hash = $2",
        [tenantId, hash, message],
      );
    }
    throw error;
  }
}

async function saveProgress(tenantId: string, hash: string, message: string): Promise<void> {
  // Only while it is being processed, so a late write can never touch a finished document.
  // A lost progress line is harmless, so errors are ignored here.
  await pool
    .query("UPDATE documents SET progress = $3 WHERE tenant_id = $1 AND file_hash = $2 AND status = 'processing'", [
      tenantId,
      hash,
      message,
    ])
    .catch(() => {});
}
