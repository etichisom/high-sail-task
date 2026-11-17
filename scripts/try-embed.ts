// Lab 9 experiment: does BGE-M3 load, and do similar meanings get similar vectors (also across languages)?
// Usage: npx tsx scripts/try-embed.ts
import { embedTexts } from "../src/retrieval/embed.js";

const texts = [
  "How do I switch on holiday mode?", // English question
  "Hoe zet ik de vakantiestand aan?", // the same question in Dutch
  "Comment activer le mode vacances ?", // the same question in French
  "The outdoor unit must be installed on a level surface.", // something unrelated
];

let started = Date.now();
const vectors = await embedTexts(texts.slice(0, 1));
console.log(`model loaded + first text: ${Date.now() - started} ms`);

started = Date.now();
vectors.push(...(await embedTexts(texts.slice(1))));
console.log(`3 more texts: ${Date.now() - started} ms`);

const first = vectors[0]!;
console.log(`${first.length} numbers per text, length ${Math.hypot(...first).toFixed(3)}`);

// The vectors have length 1, so cosine similarity is just the dot product (1 = same meaning)
const similarity = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
for (let i = 1; i < texts.length; i++) {
  console.log(`${similarity(first, vectors[i]!).toFixed(3)}  "${texts[0]}"  vs  "${texts[i]}"`);
}

const mb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
console.log(`process memory: ${mb} MB`);
