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
  // 2. keyword_hits: top 20 that contain ANY of the important words; more matches rank higher
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
       FROM chunks, to_tsquery('simple', replace(plainto_tsquery('simple', $3)::text, ' & ', ' | ')) AS query
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
    [tenantId, vector, keywords(query), config.searchCandidates, config.rrfK, limit],
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

// Small words that appear in almost every chunk. With "any word" matching they would flood the keyword
// list ("suitcase WITH A clock" matched every chunk with "a"), so they are dropped. EN / NL / FR.
const STOPWORDS = new Set(
  `a an the and or of to in on at for with by from is are was be it its this that what which how where when
  why who do does can i my me we you your there not no if than then so as into about after before
  de het een en of van in op aan voor met bij uit is zijn was wat welke hoe waar wanneer wie ik mijn je
  moet kan er niet geen als dan dat die dit om naar ook nog wordt worden te
  le la les un une des et ou du au aux en dans sur pour par avec est sont que qui quoi comment
  ou quand je mon ma mes il elle ce cette ne pas plus`.split(/\s+/),
);

// The question → its important words, for the keyword search (Postgres does the matching)
function keywords(question: string): string {
  const words = question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\-./]*/gu) ?? [];
  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word)).join(" ");
}
