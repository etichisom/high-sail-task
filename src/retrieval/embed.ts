// Turn text into BGE-M3 vectors (1024 numbers), locally in Node with Transformers.js.
// Used by ingest (embed chunks once) and by search (embed the question every time).
import { env, pipeline, type DataType, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { config } from "../config.js";

// Keep the downloaded model in our store/ folder, not hidden inside node_modules
// (npm install would otherwise throw away a 570 MB download).
env.cacheDir = config.modelCacheDir;

// Loading the model takes seconds, so do it once, and only when someone needs it.
// We keep the Promise (not the result) so two calls at the same time still load it only once.
let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", config.embeddingModel, {
    dtype: config.embeddingDtype as DataType,
  });
  return extractor;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = await getExtractor();
  const vectors: number[][] = [];

  // One text at a time. Measured on this Mac (CPU): 15.9 chunks/s one by one vs 5.6 in batches of 8,
  // because a batch is padded to its longest text, and the CPU already uses all cores for one text.
  for (const text of texts) {
    // BGE-M3's dense vector is the first token ([CLS]), scaled to length 1,
    // so cosine distance in pgvector compares meaning only, not text length.
    const output = await model(text, { pooling: "cls", normalize: true });
    const [vector] = output.tolist() as number[][];
    vectors.push(vector!);
  }
  return vectors;
}

// BGE-M3 needs no "query:" prefix: questions and chunks are embedded the same way.
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector!;
}

// pgvector reads a vector as text like "[0.1,0.2,...]", which is exactly JSON array syntax.
export function toPgVector(vector: number[]): string {
  return JSON.stringify(vector);
}
