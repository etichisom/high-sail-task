// Hybrid search: meaning (pgvector) + exact words (Postgres full-text), merged into one list.
// Meaning finds "vakantie schema" on English pages; words find exact codes like "TH1" or "IF08".
import { config } from "../config.js";
import { pool } from "../db.js";
import { embedQuery, toPgVector } from "./embed.js";

export type HybridHit = {
  id: string;
  filename: string; // the PDF, for citations
  pageStart: number;
  pageEnd: number;
  chunkType: string;
  section: string | null;
  content: string;
  vectorRank: number | null; // place in the meaning list (1 = best), null = not in its top 20
  keywordRank: number | null; // place in the word list, null = not all words found
  score: number; // merged score (RRF): higher = better
};

export async function hybridSearch(tenantId: string, query: string, limit = 5): Promise<HybridHit[]> {
  const vector = toPgVector(await embedQuery(query));

  // One SQL query with three parts:
  // 1. vector_hits:  top 20 by meaning, with their place (1, 2, 3…)
  // 2. keyword_hits: top 20 that contain ALL the words, with their place
  // 3. merge: FULL JOIN keeps chunks found by either list; score = 1/(60 + place) from each list
  const { rows } = await pool.query<{
    id: string;
    filename: string;
    page_start: number;
    page_end: number;
    chunk_type: string;
    section: string | null;
    content: string;
    vector_rank: string | null; // row_number() is a bigint, which pg returns as a string
    keyword_rank: string | null;
    score: string; // numeric, also returned as a string
  }>(
    `WITH vector_hits AS (
       SELECT id, row_number() OVER (ORDER BY embedding <=> $2::vector) AS rank
       FROM chunks
       WHERE tenant_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $4
     ),
     keyword_hits AS (
       SELECT id, row_number() OVER (ORDER BY ts_rank(tsv, query) DESC) AS rank
       FROM chunks, websearch_to_tsquery('simple', $3) AS query
       WHERE tenant_id = $1 AND tsv @@ query
       ORDER BY ts_rank(tsv, query) DESC
       LIMIT $4
     )
     SELECT c.id, d.filename, c.page_start, c.page_end, c.chunk_type, c.section, c.content,
            v.rank AS vector_rank, k.rank AS keyword_rank,
            coalesce(1.0 / ($5 + v.rank), 0) + coalesce(1.0 / ($5 + k.rank), 0) AS score
     FROM vector_hits v
     FULL JOIN keyword_hits k ON k.id = v.id
     JOIN chunks c ON c.id = coalesce(v.id, k.id) AND c.tenant_id = $1
     JOIN documents d ON d.id = c.document_id
     ORDER BY score DESC
     LIMIT $6`,
    [tenantId, vector, query, config.searchCandidates, config.rrfK, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    chunkType: row.chunk_type,
    section: row.section,
    content: row.content,
    vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
    keywordRank: row.keyword_rank === null ? null : Number(row.keyword_rank),
    score: Number(row.score),
  }));
}