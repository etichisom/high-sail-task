// All settings in one place, read from .env once.
// Other files import `config` and never touch process.env directly.
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  doclingUrl: process.env.DOCLING_URL ?? "http://localhost:5001",
  storeDir: process.env.STORE_DIR ?? "store",
  doclingPagesPerPart: Number(process.env.DOCLING_PAGES_PER_PART ?? 30), // big PDFs are converted in parts (memory)
  // BGE-M3 as ONNX, run in Node by Transformers.js (Lab 9)
  embeddingModel: process.env.EMBEDDING_MODEL ?? "Xenova/bge-m3",
  embeddingDtype: process.env.EMBEDDING_DTYPE ?? "q8", // q8 = 8-bit weights: 570 MB instead of 2.3 GB
  embedRowsPerRound: Number(process.env.EMBED_ROWS_PER_ROUND ?? 32), // chunks read + written per database round
  modelCacheDir: process.env.MODEL_CACHE_DIR ?? "store/models",
  // Hybrid search (Lab 10)
  searchCandidates: Number(process.env.SEARCH_CANDIDATES ?? 20), // top N from each search before merging
  rrfK: Number(process.env.RRF_K ?? 60), // smooths the merge; 60 is the standard value
  // Answering (Lab 11)
  answerModel: process.env.ANSWER_MODEL ?? "claude-haiku-5-5",
  answerEffort: process.env.ANSWER_EFFORT ?? "medium", // low | medium | high: how much Claude thinks first
  answerSources: Number(process.env.ANSWER_SOURCES ?? 8), // chunks from hybrid search sent to Claude
  answerMaxSearches: Number(process.env.ANSWER_MAX_SEARCHES ?? 2), // extra searches Claude may make (0 = no agent)
  // Reranker (Lab 13): reorders the hybrid search candidates before Claude sees the best few
  rerankModel: process.env.RERANK_MODEL ?? "onnx-community/bge-reranker-v2-m3-ONNX",
  rerankDtype: process.env.RERANK_DTYPE ?? "q8",
  rerankCandidates: Number(process.env.RERANK_CANDIDATES ?? 40), // hybrid search hits the reranker reads
  // Vision (Lab 8.6): Claude reads pages with icons, diagrams and broken tables, once, at ingest
  visionModel: process.env.VISION_MODEL ?? "claude-haiku-5-5",
  visionConcurrency: Number(process.env.VISION_CONCURRENCY ?? 4), // pages sent to Claude at the same time
    // Eval (Lab 12): a stronger model grades the answers against the reference answers
  judgeModel: process.env.JUDGE_MODEL ?? "claude-sonnet-5-5",
};