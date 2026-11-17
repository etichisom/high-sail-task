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
  // BGE-M3 as ONNX, run in Node by Transformers.js (Lab 9)
  embeddingModel: process.env.EMBEDDING_MODEL ?? "Xenova/bge-m3",
  embeddingDtype: process.env.EMBEDDING_DTYPE ?? "q8", // q8 = 8-bit weights: 570 MB instead of 2.3 GB
  embedRowsPerRound: Number(process.env.EMBED_ROWS_PER_ROUND ?? 32), // chunks read + written per database round
  modelCacheDir: process.env.MODEL_CACHE_DIR ?? "store/models",
};