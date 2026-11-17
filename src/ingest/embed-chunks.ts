// Give every chunk of one company its BGE-M3 vector (the chunks.embedding column).
// This is an ingest step: the worker will run it after storing new chunks.
import { pool } from "../db.js";
import { embedTexts, toPgVector } from "../retrieval/embed.js";
import { config } from "../config.js";

// Only chunks without a vector are embedded, so running it again only does new work,
// and a run that stopped halfway simply continues where it was.
export async function embedChunks(
  tenantId: string,
  onProgress?: (done: number) => void, // lets the CLI (or later the worker) show progress
): Promise<number> {
  let done = 0;

  while (true) {
    // Fetch a few rows at a time, so a company with 100,000 chunks never sits in memory at once
    const { rows } = await pool.query<{ id: string; content: string }>(
      `SELECT id, content FROM chunks
       WHERE tenant_id = $1 AND embedding IS NULL
       ORDER BY id
       LIMIT $2`,
      [tenantId, config.embedRowsPerRound],
    );
    if (rows.length === 0) return done;

    const vectors = await embedTexts(rows.map((row) => row.content));

    for (const [i, row] of rows.entries()) {
      // tenant_id in the WHERE too: a bug elsewhere can never write into another company's chunk
      await pool.query("UPDATE chunks SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3", [
        toPgVector(vectors[i]!),
        row.id,
        tenantId,
      ]);
    }

    done += rows.length;
    onProgress?.(done);
  }
}
