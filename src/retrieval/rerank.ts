// Rerank search results with BGE Reranker v2 M3 (a cross-encoder), locally in Node like BGE-M3.
// Search compares two separate vectors; the reranker reads question + chunk TOGETHER, so it is
// far more precise, also across languages. Too slow for 1,600 chunks, fast enough for the top ~50.
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type DataType,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { config } from "../config.js";

env.cacheDir = config.modelCacheDir;

// Load once, lazily (same pattern as embed.ts)
let loaded: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | undefined;

function getReranker() {
  loaded ??= (async () => ({
    tokenizer: await AutoTokenizer.from_pretrained(config.rerankModel),
    model: await AutoModelForSequenceClassification.from_pretrained(config.rerankModel, {
      dtype: config.rerankDtype as DataType,
    }),
  }))();
  return loaded;
}

// Score each text against the query: 0 = unrelated, 1 = answers it
export async function rerankScores(query: string, texts: string[]): Promise<number[]> {
  const { tokenizer, model } = await getReranker();
  const scores: number[] = [];
  // One pair at a time: on CPU that beat batching for BGE-M3 (no padding waste)
  for (const text of texts) {
    const inputs = tokenizer(query, { text_pair: text, truncation: true, max_length: config.rerankMaxTokens });
    const { logits } = await model(inputs);
    const logit = (logits.tolist() as number[][])[0]![0]!;
    scores.push(1 / (1 + Math.exp(-logit))); // sigmoid: the raw score becomes 0..1
  }
  return scores;
}

// Reorder search hits by reranker score and keep the best `top`
export async function rerank<T extends { content: string }>(
  query: string,
  hits: T[],
  top: number,
): Promise<(T & { rerankScore: number })[]> {
  const scores = await rerankScores(
    query,
    hits.map((hit) => hit.content),
  );
  return hits
    .map((hit, i) => ({ ...hit, rerankScore: scores[i]! }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, top);
}
