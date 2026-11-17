// Meaning-based search: the chunks whose vectors are closest to the question's vector.
// Keyword search (the tsv column) and combining both (hybrid) come in the next lab.
import { pool } from "../db.js";
import { embedQuery, toPgVector } from "./embed.js";

export type SearchHit = {
  id: string;
  pageStart: number;
  pageEnd: number;
  chunkType: string;
  section: string | null;
  content: string;
  distance: number; // cosine distance: 0 = same meaning, 1 = unrelated, 2 = opposite
};

export async function vectorSearch(tenantId: string, query: string, limit = 5): Promise<SearchHit[]> {
  const vector = toPgVector(await embedQuery(query));

  // <=> is pgvector's cosine distance. ORDER BY on it (smallest first) can use the HNSW index.
  // Always filter on tenant_id: a company only ever searches its own documents.
  const { rows } = await pool.query<{
    id: string;
    page_start: number;
    page_end: number;
    chunk_type: string;
    section: string | null;
    content: string;
    distance: number;
  }>(
    `SELECT id, page_start, page_end, chunk_type, section, content,
            embedding <=> $2::vector AS distance
     FROM chunks
     WHERE tenant_id = $1 AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [tenantId, vector, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    chunkType: row.chunk_type,
    section: row.section,
    content: row.content,
    distance: row.distance,
  }));
}
