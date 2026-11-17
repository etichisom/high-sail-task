# Lab 9 — Embeddings: search by meaning

## What and why

Until now we can only find chunks by **words** (the `tsv` column). A technician who asks
"vakantie schema" (Dutch) will not find the English page that says "Holiday schedule",
because no word matches.

An **embedding** is a list of 1024 numbers that describes the *meaning* of a text.
Texts with a similar meaning get similar numbers, also across languages.
We use **BGE-M3** (multilingual, 1024 numbers, long texts up to 8k tokens).

In this lab we:

1. run BGE-M3 **inside Node** with Transformers.js (no extra Docker container),
2. fill `chunks.embedding` (already in the schema: `vector(1024)`) for every chunk of a company,
3. build a first search by meaning: `npm run search -- --tenant demo "your question"`.

Combining this with keyword search (hybrid) is the next lab.

```
INGEST (once)    chunk text ──► BGE-M3 ──► 1024 numbers ──► chunks.embedding
SEARCH (always)  question   ──► BGE-M3 ──► 1024 numbers ──► ORDER BY embedding <=> question  ──► top 5
```

New files:

```
src/retrieval/embed.ts          embedTexts(), embedQuery(): the model, loaded once
src/ingest/embed-chunks.ts      embedChunks(tenantId): fill chunks.embedding
src/retrieval/vector-search.ts  vectorSearch(tenantId, query): top chunks by meaning
src/cli/embed.ts                npm run embed
src/cli/search.ts               npm run search
scripts/try-embed.ts            a quick experiment (like scripts/test-claude.ts)
```

Before you start: Docker is running (`manual-db` on port 5433) and tenant "demo" has its 72 chunks from Lab 8.

---

## 9.1 Install Transformers.js

Transformers.js is Hugging Face's library to run models in JavaScript. It uses
**ONNX Runtime** (a fast C++ engine) under the hood, so the model runs at native speed on the CPU.

```bash
npm install @huggingface/transformers@4.3.2
```

npm prints a warning like `npm warn install-scripts protobufjs ... (postinstall ...)`.
That is fine: npm did not run that script, and we don't need it (ONNX Runtime ships ready-made files for Mac).

Check that the Mac version of ONNX Runtime is there:

```bash
ls node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/
```

Expected:

```
libonnxruntime.1.30.0.dylib  libonnxruntime.1.dylib  onnxruntime_binding.node
```

| Package | What it does |
|---|---|
| `@huggingface/transformers` 4.3.2 | Downloads the model + tokenizer from Hugging Face and runs them |
| `onnxruntime-node` 1.30 (installed with it) | The engine that does the maths, on all CPU cores |
| Model `Xenova/bge-m3` | BAAI's BGE-M3, converted to ONNX for Transformers.js |

---

## 9.2 Settings

Add four settings to `src/config.ts`. The whole file:

```ts
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
```

| Setting | Value | Why |
|---|---|---|
| `embeddingModel` | `Xenova/bge-m3` | The ONNX version of BGE-M3 on Hugging Face |
| `embeddingDtype` | `q8` | 8-bit weights: 570 MB download instead of 2.3 GB, faster on CPU, almost the same vectors (see "Numbers") |
| `embedRowsPerRound` | 32 | How many chunks we read from Postgres, embed, and write back per round |
| `modelCacheDir` | `store/models` | Where the model is saved after the first download. `store/` is already in `.gitignore` |

---

## 9.3 The model: `src/retrieval/embed.ts`

Library code only: no `argv`, no printing. It lives in `src/retrieval` because both
ingest (embed chunks) and search (embed the question) use it.

```bash
mkdir -p src/retrieval
```

```ts
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
```

| Part | What it does |
|---|---|
| `env.cacheDir` | Saves the model in `store/models`. The default is inside `node_modules`, which `npm install` can wipe |
| `pipeline("feature-extraction", …)` | Loads tokenizer + model. "feature-extraction" = give me the numbers, not a text answer |
| `extractor ??= …` | Load once, lazily: the first call starts loading, every later call reuses the same Promise |
| `pooling: "cls"` | The model gives one vector per token. BGE-M3's "dense" vector is the first token's vector ([CLS]). **Not** `mean`: that is for other models and gives worse BGE vectors |
| `normalize: true` | Scale every vector to length 1, as BGE-M3 is trained for. Then cosine distance = pure meaning |
| one text at a time | Faster than batches on CPU (measured: see "Numbers") |
| `toPgVector` | pgvector accepts `'[0.1,0.2,…]'` as text, and `JSON.stringify` writes exactly that |

---

## 9.4 Try the model

A small experiment, in the same place as the Lab 4 test (`scripts/`). It embeds the same question in
EN / NL / FR plus one unrelated sentence, and compares them.

```ts
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
```

The first run downloads the model (about 590 MB: model 570 MB + tokenizer 17 MB) into `store/models`.
That took about 3 minutes here.

```bash
npx tsx scripts/try-embed.ts
```

Expected (second run, model already downloaded):

```
model loaded + first text: 1847 ms
3 more texts: 160 ms
1024 numbers per text, length 1.000
0.738  "How do I switch on holiday mode?"  vs  "Hoe zet ik de vakantiestand aan?"
0.841  "How do I switch on holiday mode?"  vs  "Comment activer le mode vacances ?"
0.372  "How do I switch on holiday mode?"  vs  "The outdoor unit must be installed on a level surface."
process memory: 728 MB
```

What this shows:
- 1024 numbers, length 1.000: CLS pooling + normalise work.
- The Dutch and French questions score **0.74 and 0.84**, the unrelated sentence only **0.37**.
  So a Dutch question can find an English page. That is why we chose BGE-M3.
- Loading takes under 2 seconds once downloaded; after that a short text takes only tens of milliseconds.
- Memory: between 0.7 and 1.4 GB in our runs (it changes per run).

Check the download size:

```bash
du -sh store/models
```

```
561M	store/models
```

---

## 9.5 Find a company without creating one

`findOrCreateTenant` (Lab 8) creates a company if the name is new. For `embed` and `search`
a typo like `--tenant dmeo` should give an error, not a new empty company.
Add this function at the end of `src/tenants.ts`:

```ts
// For commands that work on an existing company (embed, search): a typo must not create an empty one.
export async function findTenant(name: string): Promise<string | undefined> {
  const found = await pool.query<{ id: string }>("SELECT id FROM tenants WHERE name = $1", [name]);
  return found.rows[0]?.id;
}
```

---

## 9.6 Fill `chunks.embedding`: `src/ingest/embed-chunks.ts`

Why in `src/ingest` and not `src/retrieval`? Giving chunks their vectors is a step of the
ingest pipeline (route → Docling → chunk → **embed** → ready). The background worker will call
this function after `ingestDocument`. `src/retrieval` holds what search uses at question time.

```ts
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
```

| Part | Why |
|---|---|
| `WHERE tenant_id = $1 AND embedding IS NULL` | Only this company, only chunks without a vector. Run it twice: the second run does nothing. Stopped halfway: the next run continues |
| `LIMIT $2` (32) + `while (true)` | Read a few rows per round, so a huge company never sits in memory at once |
| `$1::vector` | Postgres turns our `'[…]'` text into a pgvector value |
| `AND tenant_id = $3` in the UPDATE | Defence in depth: even with a wrong id, we can never write into another company's chunk |
| `onProgress` | The library does not print; the CLI (or later the worker) decides what to show |

No transaction here, on purpose: every UPDATE is complete on its own. If the program stops,
the chunks done so far keep their vectors, and the rest still have `embedding IS NULL`.

---

## 9.7 The embed command: `src/cli/embed.ts`

```ts
// Embed all chunks of one company that have no vector yet.
// Usage: npm run embed -- --tenant <company name>
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { embedChunks } from "../ingest/embed-chunks.js";
import { findTenant } from "../tenants.js";

const { values } = parseArgs({ options: { tenant: { type: "string" } } });
if (!values.tenant) {
  console.error("Usage: npm run embed -- --tenant <company name>");
  process.exit(1);
}

const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}". Run ingest first.`);
  process.exit(1);
}

const started = Date.now();
const count = await embedChunks(tenantId, (done) => console.log(`  ${done} chunks embedded…`));
const seconds = (Date.now() - started) / 1000;

if (count === 0) {
  console.log(`tenant "${values.tenant}": all chunks already have an embedding`);
} else {
  // The time includes loading the model (a few seconds), so small runs look slower per chunk
  console.log(
    `tenant "${values.tenant}": ${count} chunks embedded in ${seconds.toFixed(1)}s (${(count / seconds).toFixed(1)} chunks/s)`,
  );
}

await pool.end();
```

```bash
npm pkg set scripts.embed="tsx src/cli/embed.ts"
```

```bash
npm run embed -- --tenant demo
```

Expected:

```
> high-sail-task@1.0.0 embed
> tsx src/cli/embed.ts --tenant demo

  32 chunks embedded…
  64 chunks embedded…
  72 chunks embedded…
tenant "demo": 72 chunks embedded in 6.6s (10.9 chunks/s)
```

Run it again: nothing to do.

```bash
npm run embed -- --tenant demo
```

```
tenant "demo": all chunks already have an embedding
```

Check in Postgres:

```bash
docker exec manual-db psql -U manual -d manual -c "SELECT count(*) AS chunks, count(embedding) AS with_embedding FROM chunks WHERE tenant_id = (SELECT id FROM tenants WHERE name = 'demo')"
```

```
 chunks | with_embedding 
--------+----------------
     72 |             72
(1 row)
```

---

## 9.8 Search by meaning: `src/retrieval/vector-search.ts`

```ts
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
```

| Part | What it does |
|---|---|
| `embedQuery(query)` | The question gets its own 1024 numbers, with the same model |
| `embedding <=> $2::vector` | pgvector's **cosine distance**. Small = close in meaning |
| `ORDER BY embedding <=> …` | Written out in full (not the alias `distance`) so Postgres can use the HNSW index `chunks_embedding_idx` from Lab 6 once there are many chunks |
| `WHERE tenant_id = $1` | A company only searches its own documents |
| `embedding IS NOT NULL` | Chunks not embedded yet are skipped instead of sorting last |

---

## 9.9 The search command: `src/cli/search.ts`

```ts
// Try meaning-based search from the terminal.
// Usage: npm run search -- --tenant <company name> "your question"
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { vectorSearch } from "../retrieval/vector-search.js";
import { findTenant } from "../tenants.js";

const { values, positionals } = parseArgs({
  options: { tenant: { type: "string" } },
  allowPositionals: true,
});
const query = positionals.join(" ");
if (!values.tenant || !query) {
  console.error('Usage: npm run search -- --tenant <company name> "your question"');
  process.exit(1);
}

const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}".`);
  process.exit(1);
}

const hits = await vectorSearch(tenantId, query, 5);
console.log(`"${query}"\n`);
for (const [i, hit] of hits.entries()) {
  const pages = hit.pageStart === hit.pageEnd ? `p${hit.pageStart}` : `p${hit.pageStart}-${hit.pageEnd}`;
  // One line per hit: newlines inside the chunk would break the layout
  const preview = hit.content.replace(/\s+/g, " ").slice(0, 80);
  console.log(`${i + 1}. ${hit.distance.toFixed(3)}  ${pages.padEnd(6)} ${hit.chunkType.padEnd(6)} ${preview}`);
}
if (hits.length === 0) console.log("No chunks with embeddings yet. Run: npm run embed -- --tenant " + values.tenant);

await pool.end();
```

```bash
npm pkg set scripts.search="tsx src/cli/search.ts"
```

Columns in the output: rank, cosine distance, page(s), chunk type, first 80 characters.

### Search 1: English, words that appear in the manual

```bash
npm run -s search -- --tenant demo "holiday mode icon"
```

```
"holiday mode icon"

1. 0.408  p9     text   [Holiday] and thus reduced power usage whilst the property is unoccupied. Holida
2. 0.421  p9     text   <Editing holiday mode> - [Schedule]: It can be activated/deactivated by the togg
3. 0.421  p5     table  Home screen icons | No. | Icons | Description | | --- | --- | --- | | 1 | | Aler
4. 0.485  p6     figure [Heating / Cooling] Zone °C °C °C Zone DHW °C °C °C + Menu Back Schedule Holiday
5. 0.512  p9     figure [Setting] [Holiday schedule] Holiday Schedule /Sep/ --/---/---- Heating / Coolin
```

The page 5 **"Home screen icons"** table (its row 4: "Holiday schedule is activated") is #3, almost tied with
the two page 9 holiday texts (0.421 vs 0.408). All five hits are about holiday mode.

### Search 2: Dutch question, English manual

```bash
npm run -s search -- --tenant demo "vakantie schema"
```

```
"vakantie schema"

1. 0.453  p9     figure [Setting] [Holiday schedule] Holiday Schedule /Sep/ --/---/---- Heating / Coolin
2. 0.483  p8     figure [Heating schedule zone 1] Preview Save the settings. Back Heating schedule zone 
3. 0.495  p9     text   [Holiday] and thus reduced power usage whilst the property is unoccupied. Holida
4. 0.502  p8-9   text   [Heating schedule zone 1] Preview - * - Select the programme you want to schedul
5. 0.519  p9     text   <Editing holiday mode> - [Schedule]: It can be activated/deactivated by the togg
```

No Dutch word appears in this manual, yet #1 is the page 9 **Holiday schedule** screen and the
others are the schedule and holiday pages. Keyword search finds nothing here. This is the cross-language win.

### Search 3: describing the icon, not naming it

```bash
npm run -s search -- --tenant demo "suitcase with a clock"
```

```
"suitcase with a clock"

1. 0.519  p7     figure [Room sensors] Settings Date / Time Display Language Room sensors Back 1/2 K
2. 0.538  p9     figure [Setting] [Holiday schedule] Holiday Schedule /Sep/ --/---/---- Heating / Coolin
3. 0.545  p7     text   [Menu] The following items can be set. - [Schedule] - [Holiday] · [Setting] · [S
4. 0.549  p9     figure [Setting] [Settings] Page 1 Settings Date / Time Display Language Room sensors B
5. 0.553  p10    text   The serial number is indicated on the SPEC NAME PLATE. Year of manufacture: 2023
```

Honest result: **a miss**. The p5 icon table is not in the top 5, and the distances (0.52+) are worse than in
searches 1 and 2. That is expected: the manual shows the holiday icon only as a *picture*. The table row only
says "Holiday schedule is activated"; nothing in our chunks says "suitcase". Only the Haiku vision chunks (Lab 8.6)
will describe what the icons look like. Hit #2 (the Holiday schedule screen) is luck, through "clock" ≈ schedule/time.

Good to know: vector search **always** returns 5 hits, even for nonsense. The distance tells you how sure it is.
That matters later for abstention ("not in the documents").

Try a wrong company name:

```bash
npm run -s search -- --tenant nope "x"
```

```
No company called "nope".
```

---

## 9.10 Typecheck

```bash
npm run typecheck
```

No output = no errors.

---

## 9.11 Commit

```bash
git add package.json package-lock.json src/config.ts src/tenants.ts src/retrieval src/ingest/embed-chunks.ts src/cli/embed.ts src/cli/search.ts scripts/try-embed.ts
```

```bash
git commit -m "Embeddings: BGE-M3 in Node (Transformers.js, q8), embed and search CLIs"
```

`store/models` is not committed (`store/` is in `.gitignore`).

---

## Numbers (MacBook M3 Pro, 18 GB, CPU only, while Docling was converting PDFs in the background)

| What | Value |
|---|---|
| Download (q8) | 570 MB model + 17 MB tokenizer = **561 MB on disk** (fp32 would be 2.3 GB) |
| First download | ~3 minutes |
| Model load (already downloaded) | **1.2–1.7 s** |
| One question (embedQuery, after loading) | **~8 ms** for a short question |
| Embed 72 demo chunks | **6.6 s total incl. load = 10.9 chunks/s**; model alone 4.6 s = **15.8 chunks/s** |
| Whole `npm run search` command | ~1.5 s (start Node + load model + search) |
| Process memory | ~0.7–1.4 GB while running, peak ~1.6–2.2 GB while loading |
| Docker memory | **0**: the model runs in Node, outside the Docker VM |
| Estimate for the whole pack (~585 pages ≈ 4,000+ chunks at Mitsubishi's 7 chunks/page) | ~5–7 minutes |

Batch size test (q8, same 72 chunks, model time only):

| Texts per model call | Unsorted | Sorted by length |
|---|---|---|
| **1** | **15.8 chunks/s** | 15.9 chunks/s |
| 4 | 7.3 | 13.3 |
| 8 | 5.6 | 11.4 |
| 16 | 4.3 | 10.6 |
| 32 | 3.3 | — |

q8 vs full precision (fp32), measured once, both one text at a time (you don't need to repeat this: fp32 is a 2.3 GB download):

| | q8 (our choice) | fp32 |
|---|---|---|
| Download | 570 MB | 2.3 GB |
| Load time | 1.6 s | 7.5 s |
| Speed (72 chunks, busy CPU) | 6.4 chunks/s | 1.2 chunks/s |
| Similarity of the two vectors for the same chunk | mean **0.986**, lowest 0.979 | (reference) |
| Top 5 for our three searches | **the same 5 chunks** in all three | |

So q8 is about 5× faster and finds the same chunks; only the order of near-ties changes a little
(e.g. "holiday mode icon": the two p9 texts swap places). The eval can check this again later on all questions.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the model runs | **Transformers.js in Node**, not a TEI Docker container | Docker has a fixed memory budget and Docling already needs most of it (it was OOM-killed at 8 GB in Lab 8). The model in Node uses normal Mac memory and adds no container. BGE-M3 loads fine and gives correct vectors (1024 numbers, length 1, EN/NL/FR questions close together). TEI stays the plan B if speed ever becomes a problem (e.g. a server without enough CPU) |
| Model file | `q8` (8-bit) | 4× smaller download, quicker to load; the vectors are almost the same as full precision (see the comparison above) |
| Pooling | **CLS** + normalise | That is how BGE-M3's dense vector is defined by its makers (BAAI). Mean pooling would give different, worse vectors. Normalised vectors make cosine distance compare meaning only |
| No query prefix | Embed questions and chunks the same way | Older BGE models needed "Represent this sentence for searching…" in front of questions; BGE-M3 does not |
| Batch size | **1 text per model call**, 32 chunks per database round | Measured: on CPU, batches are slower, because every text in a batch is padded to the longest one (our chunks vary from 20 to 2,000 characters) and ONNX Runtime already uses all cores for one text. Also, with q8 the numbers of a text change slightly with its batch neighbours; one at a time gives the same vector every time. On a GPU, batching would win |
| Where `embedChunks` lives | `src/ingest/` | It is an ingest step; the worker will run it after `ingestDocument` |
| Only `embedding IS NULL` | Embed only what is new | Re-running is free; a crash halfway just continues; a new document only embeds its own chunks |

---

## What we learned / next

- Meaning search finds the Dutch question on English pages (search 2) — keyword search cannot.
- It cannot find what is only in a picture (search 3) → the Haiku vision chunks (8.6) are still needed.
  Run `npm run embed -- --tenant demo` again after adding them: only the new chunks get embedded.
- Vector search always returns something; a distance limit (or the reranker) must help decide "not in the documents".
- Next lab: **hybrid search** = this + keyword search (`tsv`), so exact codes like "E47" or "F12" are found too.
- Note for many companies: the HNSW index first finds the ~40 nearest chunks of *all* companies and then filters
  on `tenant_id`, so a small company could get fewer than 5 hits. pgvector 0.8 (we have 0.8.7) fixes this with
  `SET hnsw.iterative_scan = relaxed_order`. Not needed with one company; remember it for the scale question.
