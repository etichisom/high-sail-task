# Ask the Manual — Work Plan

Timebox: 4–6 h for core. Tickets are in build order. Each one has a clear "done when".

Stack (proposal): TypeScript + Node, CLI first (`ask`, `ingest`, `eval`), small HTTP endpoint at the end.
Models: Claude for vision transcription, answering and judging. A multilingual embedding model for retrieval.
Storage: local files (JSON / SQLite) — no infra needed for 10 docs.

---

## Phase 0 — Understand the data (≈45 min) — do this BEFORE coding

### T0.1 Unpack and inventory the pack
- Unzip `ask-the-manual-pack.zip` into `data/`.
- For every document, write down: name, language, page count, has text layer? (yes/no), type (manual / scan / P&ID / pictogram manual).
- **Done when:** `docs/inventory.md` has one row per document.

### T0.2 Study `dev-questions.json`
- Group the ~20 questions: error codes, wiring, pictograms, P&ID, numeric tables, cross-language, no-answer.
- Open the cited pages and look at *why* each one is hard (table? image? icon? scan?).
- **Done when:** each question is tagged with a category and the "hard part" in `docs/inventory.md`.

---

## Phase 1 — Ingestion (≈1.5 h)

### T1.1 Project skeleton
- `npm init`, TypeScript, `src/` with `ingest.ts`, `ask.ts`, `eval.ts`, `.env` for API keys.
- **Done when:** `npm run ingest`, `npm run ask "..."`, `npm run eval` exist (even as stubs).

### T1.2 Page rendering + text extraction
- Render every PDF page to PNG (`pdftoppm` / `pdfjs`).
- Extract the text layer per page where it exists.
- **Done when:** `store/pages/<doc>/<page>.{png,txt}` exists for all docs.

### T1.3 Vision transcription for hard pages
- Pages with no / little text (the scan), diagrams (wiring, P&ID), tables and pictograms → send the page image to a vision model.
- Prompt it to produce structured text: tables as markdown, wiring as "terminal X → wire Y", P&ID as "component + tag + what it connects to", icons as "icon description → meaning".
- Cache results so it runs only once per page (and only for new docs → stretch goal "add a doc without reprocessing").
- **Done when:** every page has usable text, and the P&ID / pictogram / scan pages read correctly when you eyeball them.

### T1.4 Chunking + index
- One chunk per page (or per section/table within a page), with metadata: `doc`, `page`, `language`, `section/table title`.
- Build embeddings (multilingual) + a keyword index (BM25) — error codes like "E47" and model names like "8kW" need exact keyword match.
- **Done when:** `store/index` is built and a quick search for "E47" returns the right page.

---

## Phase 2 — Ask + Abstain (≈1.5 h)

### T2.1 Retrieval
- Detect question language. Rewrite / translate the query (handles typos, Dutch question vs English doc).
- Hybrid search: BM25 + vector, merge results, take top ~8 pages.
- **Done when:** for most dev questions, the correct page is in the top 8 (measure it — this becomes "retrieval recall" in the eval).

### T2.2 Answer generation with citations
- Send the question + retrieved chunks (optionally the page image for diagram pages) to the LLM.
- Force structured output: `{ answer, citations: [{doc, page, quote/table/row}], abstained: bool }`.
- Rules in the prompt: answer only from the given text, answer in the question's language, give numbers with units and the model they belong to, cite every claim.
- **Done when:** `npm run ask "unit shows E47 what do i do"` prints an answer + doc/page.

### T2.3 Abstention
- If the evidence doesn't contain the answer → return "The documents do not cover this" (in the user's language), no guessing.
- Optional second check: a cheap verifier that confirms each cited quote really exists on the cited page.
- **Done when:** the "no answer" dev questions all abstain, and answerable ones don't.

---

## Phase 3 — Evaluation (≈1 h) — this is part of the product

### T3.1 Eval runner
- One command: `npm run eval` → runs all of `dev-questions.json`.
- Per question record: answer, citations, abstained, latency (ms, wall clock), input/output tokens, cost ($ from real token counts).

### T3.2 Metrics
- **Answer correctness:** LLM-as-judge against the reference answer (correct / partial / wrong), plus exact check for numbers + units.
- **Citation quality:** cited doc matches? cited page matches (or within ±1)?
- **Abstention:** precision/recall on the no-answer questions (false abstain vs. hallucination).
- **Retrieval recall@k:** was the reference page retrieved at all? (tells you if a failure is retrieval or generation).
- **Latency:** p50 / p95. **Cost:** avg $ per question, plus one-time ingest cost.
- **Done when:** a printed table per question + a summary, saved to `eval/results-<timestamp>.json`.

### T3.3 Be honest about the numbers
- Read through failures by hand. Check the judge isn't too generous.
- Note that the dev set is small (~20) → report numbers as counts, not just %.

---

## Phase 4 — Debrief readiness (≈30 min)

### T4.1 Run on new questions
- `npm run ask "<question>"` works from a clean clone; optional `POST /ask` HTTP endpoint.
- Optional: `npm run eval -- --file their-questions.json` so they can run their held-out set directly.

### T4.2 README
- Setup + how to run ingest / ask / eval.
- Short architecture sketch (ingest → index → retrieve → answer → verify).
- Eval results table from T3.
- Tradeoffs + what didn't work.
- "Another week" + "scaling to 500 companies × 10,000 docs" (per-tenant indexes, incremental ingest queue, cheaper vision pass, caching, re-ranking, monitoring answer quality in production).

---

## Stretch (only if core is solid)

- [ ] S1 — Compare two approaches with eval numbers (e.g. text-only retrieval vs. retrieval + page images sent to the model; or with/without query translation)
- [ ] S2 — More precise citations: table name / row, quoted snippet, bounding box
- [ ] S3 — Streaming answers
- [ ] S4 — Follow-up questions (keep conversation history, rewrite follow-up into standalone question)
- [ ] S5 — Incremental ingest: hash each file, only process new/changed docs

---

## Checklist vs. the brief's "must haves"

- [ ] Ingest all docs incl. scan, P&ID, pictogram manual → T1.2–T1.4
- [ ] Grounded answers with doc + page citations → T2.2
- [ ] Answer in the question's language → T2.1, T2.2
- [ ] Correct "not in the documents" → T2.3
- [ ] Repeatable eval with printed report → T3.1, T3.2
- [ ] Latency + cost measured, not estimated → T3.1
- [ ] Way to run new questions in the debrief → T4.1
