# Ask the Manual — Lab Notes

A running log of what we built, why, and what we learned. Updated after every lab.
This becomes the raw material for the final README and the interview walkthrough.

---

## 0. The task in one paragraph

Build a service that answers a field technician's question from a pack of 9 technical PDFs
(heat pumps, a plant room), **in the language the question was asked in**, with **citations
(document + page)**, and that **says "not in the documents"** instead of guessing. One command
must evaluate the system on 21 dev questions and report answer quality, citation quality,
latency and cost per question. The company will run hidden questions on it in the debrief.

**What makes it hard:** the documents are messy: a scan with no text, a P&ID drawing, manuals
that explain things with icons, tables per model, and three languages (EN / NL / FR).

---

## 1. Overall design (RAG)

RAG = **R**etrieval-**A**ugmented **G**eneration: find the relevant pages, put them in the
prompt, let the AI answer only from those pages.

```
INGESTION (once, in advance)
PDF pages ──► text / vision transcription ──► chunks ──► search index
                                              (doc, page, language)

ASK (every question, must be fast)
question ──► RETRIEVE top chunks ──► AUGMENT prompt ──► GENERATE answer + citations
                                                         or "not in the documents"
```

**Why RAG and not "send all documents to the AI":** all ~585 pages is roughly 500k+ tokens,
so every question would cost ~$2+ and take a minute or more. With RAG we send ~8 pages:
a few cents and a few seconds.

**Why ingestion needs vision:** a RAG system can only find what is in its index. If the scan,
P&ID and icon pages go in as empty text, retrieval can never find them, no matter how good
the search is.

---

## 2. Lab 1 — Getting the data (Ticket T0.1)

**What we did**
- Copied the pack into `data/`: `data/docs/` (9 PDFs), `data/dev-questions.json`, `data/README.md`.
- Measured each PDF: page count, and how much machine-readable text each page has
  (`pdfinfo` for pages, `pdftotext` for text). A page with < 200 characters is basically an image.
- Wrote the results to `docs/inventory.md`.

**Results**

| Document | Lang | Pages | Pages with almost no text | Type |
|---|---|---|---|---|
| dedietrich-alezio-m-r32-notice | FR | 180 | 5 | Installer / user manual |
| ecoflow-r290-wire-controller | EN | 24 | 0 | Controller manual with pictograms |
| midea-r290-mono-4-16kw-installation | EN | 93 | 1 | Installation manual |
| mitsubishi-ecodan-hydrobox-operation | EN | 10 | 0 | Operation manual with display icons |
| panasonic-aquarea-ht-service-manual | EN | 119 | **31** | Service manual, many diagram pages |
| panasonic-aquarea-storingsanalyse | NL | 68 | 1 | Error-code / troubleshooting guide |
| remeha-e-hp-handleiding | NL | 46 | 3 | User manual |
| sporthal-de-brug-pid | NL | 1 | **1** | P&ID drawing (no text layer) |
| weil-mclain-eco-hp-odu | EN | 44 | **44** | Scanned manual (no text layer) |

**What we learned**
- 6 of 9 documents are mostly readable text.
- 3 documents (scan, P&ID, Panasonic diagrams) are unreadable with normal text extraction:
  ~85 pages need a vision model.
- "Has text" is not enough: icons and tables also hide inside pages that do have text.

---

## 3. Lab 2 — Understanding the questions (Ticket T0.2)

**What we did:** read all 21 dev questions and grouped them by what makes them hard.

| Group | Questions | What makes it hard |
|---|---|---|
| Error codes | dev-03, 04, 09, 11, 14 | Answer spread over 2 pages or 2 documents; Dutch question vs English doc |
| Numbers from tables | dev-02, 06, 07, 10, 12, 13 | Must pick the right model (8kW, 12kW 3-phase, 48 MBH) and right row, with unit |
| Scan | dev-09, 10 | No text layer at all |
| Icons / pictograms | dev-01, 15, 16, 17 | Answer is in a picture ("shield with a snowflake", "suitcase with a clock") |
| P&ID drawing | dev-19, 20, 21 | One drawing page, must follow pipes and read tags |
| Not in the pack | dev-05, 08, 18 | Must abstain. dev-08 and dev-18 are traps: the doc exists but lacks that fact |

Totals: **18 answerable, 3 not answerable; 13 English, 8 Dutch.**

**What we learned**
- About half the questions cannot be answered from extracted PDF text → vision is required.
- Page numbers in `dev-questions.json` are **PDF page numbers (counted from 1)**, not the
  number printed on the page. Our citations must use the same.

---

## 4. Lab 3 — Project setup (Ticket T1.1)

**What we did**
- Created an Anthropic API key and stored it in `.env` (never committed; listed in `.gitignore`).
- `git init`, branch `main`, `.gitignore` with `.env`, `node_modules/`, `store/`.
- `npm init`, set `"type": "module"` (modern `import` syntax).
- Installed:

| Package | Why |
|---|---|
| `@anthropic-ai/sdk` | Call Claude from code |
| `dotenv` | Load the API key from `.env` |
| `typescript` | The language |
| `tsx` | Run `.ts` files directly, no build step |
| `@types/node` | Type info for Node's built-ins |

- `tsconfig.json`: TypeScript settings (strict mode, source in `src/`).

**Lesson:** setup commands run once. Re-running `npm init -y` reset `package.json` and had to be fixed.

---

## 5. Lab 4 — Proving vision transcription works

**What we did:** `src/test-claude.ts` takes one PDF page, turns it into a PNG image
(`pdftoppm`, 150 dpi), sends it to Claude (`claude-opus-5-5`), and asks it to transcribe
everything as markdown: tables as tables, icons described in words + their meaning,
diagrams as components + tags + connections. It prints the result, latency and cost.

Run: `npx tsx src/test-claude.ts <pdf> <page>`

**Results on the three hardest document types**

| Test | Dev question | What Claude found | Time | Cost |
|---|---|---|---|---|
| Icons — Mitsubishi p5 | dev-17 "suitcase with a clock" | "Suitcase with a clock → Holiday schedule is activated" | 25 s | $0.075 |
| Scan — Weil-McLain p35 | dev-09 "H6 what do I check" | "H6 = DC fan motor fault: (1) strong wind spins fan backwards → turn unit / shelter, (2) replace fan motor" | 8 s | $0.031 |
| P&ID — Sporthal p1 | dev-19, 20, 21 | V-202 butterfly valve between TV-201 and BT-01; EV-01 200 L / 1.5 bar; SV-01 3 bar | 47 s | $0.13 |

**What we learned**
1. **Vision works on all hard types**: icons, scans and drawings.
2. **Too slow for question time** (8–47 s per page) → transcribe every page **once** at
   ingestion and save it.
3. **The AI turns pictures into searchable words**: "suitcase with a clock" now exists as
   text, so a technician's description can be matched.
4. **Printed page ≠ PDF page**: Mitsubishi PDF page 5 is printed as "4". Always cite the PDF page.
5. **Output is not deterministic**: two runs on the same page gave slightly different text
   and cost ($0.066 vs $0.075). Another reason to save transcriptions once.
6. **Cost is mostly output tokens**: busy pages cost more.
7. **Traps found**
   - P&ID revision table says EV-01 was enlarged *from 150 L* to 200 L → must answer 200 L.
   - Two safety devices: SV-01 3 bar (primary heating) and SG-301 7 bar (hot tap water).
   - Weil-McLain H4 says "see L0 and L1": an answer that needs another page.
8. **Risk:** the P&ID is A1 size; small text could blur in one image. Could tile big drawings.

---

## 5b. Lab 5 — Haiku vision test

Same Mitsubishi page 5, `claude-haiku-5-5`:

| | Opus 5.5 | Haiku 5.5 |
|---|---|---|
| "Suitcase with clock → Holiday schedule is activated" | ✅ | ✅ |
| Text, table rows, footnotes | ✅ | ✅ |
| Time | 25 s | 14 s |
| Cost | $0.086 | **$0.0021** (~40× cheaper) |

**But** Haiku's icon *descriptions* are less precise: quiet mode "cloud/leaf-like symbol" (Opus:
"outdoor unit with sound-level bars", which matches the page text), lock menu "list icon with a
lock" (likely invented from the word "lock"). Lesson: the cheap model gets the facts right but can
misdescribe the picture, which is exactly what icon questions search on.
Still to do: Haiku on the P&ID, and a human check of the disputed icons in the PDF.

---

## 5c. Lab 6 — Infrastructure

**What we did**
- `docker-compose.yml` with one service `db`: image `pgvector/pgvector:pg17`, host port **5433**
  (avoids clashing with a local Postgres on 5432), named volume `pgdata` so data survives restarts.
- `.env`: `DATABASE_URL=postgres://manual:manual@localhost:5433/manual`
- `docker compose up -d` → enabled pgvector (version 0.8.7).
- `db/schema.sql` loaded with `docker compose exec -T db psql -U manual -d manual < db/schema.sql`.
  The file is idempotent (`IF NOT EXISTS`), so it can be re-run safely.

**Tables (7)**

| Table | Purpose | Key columns |
|---|---|---|
| tenants | A company | id, name |
| users | Login, belongs to one tenant | tenant_id, email (unique), password_hash |
| sessions | Login sessions (cookie = id) | user_id, expires_at |
| documents | One uploaded PDF + processing status | tenant_id, filename, file_hash, status, progress, error; unique (tenant_id, file_hash) |
| chunks | Searchable pieces | tenant_id, document_id, page_start/end (PDF pages), chunk_type, section, language, source, content, embedding vector(1024), tsv |
| conversations | A chat thread | tenant_id, user_id, title |
| messages | Each question/answer | tenant_id, role, content, citations jsonb, abstained, latency_ms, tokens, cost_usd, feedback |

**Indexes:** tenant_id (fast tenant filter), HNSW on embedding (vector search), GIN on tsv
(keyword search), messages by conversation + time.

**Design reasons**
- `tenant_id` on chunks and messages too, so every query filters by company without a join.
- `to_tsvector('simple', …)` keeps codes like E47, H6, V-202 intact and works for EN/NL/FR.
- `ON DELETE CASCADE`: deleting a company removes all its data.
- Chat history stored for follow-up questions, UI history, and production monitoring
  (latency, cost, abstentions, 👍/👎 feedback). Retention policy = README next step.

**Lesson:** order matters in SQL files: a table or index must come after the tables it references.

---

## 5d. Lab 7 — Docling + RapidOCR (PaddleOCR models) test

**Setup**
- Added a `docling` service to `docker-compose.yml`: image `quay.io/docling-project/docling-serve`,
  port **5001**, `DOCLING_SERVE_ENABLE_UI=true` → web UI at `http://localhost:5001/ui`.
- Image is ~5.4 GB. **Incident:** the Mac disk was full (1.4 GB free), so the pull failed with
  `input/output error` and corrupted Docker's storage. Fix: freed space (Xcode DerivedData, simulator
  data), reset Docker's disk, re-pulled, reloaded `db/schema.sql`. Lesson: check `df -h` before big pulls.
- Docker on a Mac has **no GPU**, so all Docling models run on CPU (~6 cores busy during a conversion).

**Results (UI, default options; scan with Force OCR)**

| Document | Pages | Time | Result |
|---|---|---|---|
| Panasonic storingsanalyse (NL, text) | 68 | ~3–4.5 min | ✅ Headings clean (one section per error code), F12 perfect (dev-03), simple tables good. ❌ Big error-code table 2.2 (p16) scrambled; 149 duplicated text blocks (hidden double text layer); flowcharts are only `![Image]`; formulas garbled |
| Weil-McLain ODU (EN, scan) | 44 | 181 s (~4 s/page) | ✅ H6 = DC fan motor fault + both checks, p35 (dev-09). ✅ MCA 34 A / MFA 50 A / 8 AWG, p28 (dev-10). ⚠️ OCR code errors: `HO`→H0, `HI`→H1, `hH`→H4, `(r snpr)`→(Tp sensor) |
| Mitsubishi Ecodan (EN, icons) | 10 | fast | ❌ Icon column of the p5 table is **empty**; "Holiday schedule is activated" is there but nothing says "suitcase with a clock" → dev-17 fails. Icons OCR'd as junk (`日`, `山`, `III`) |
| Sporthal P&ID (1 page, A1 drawing) | 1 | fast | ❌ Tags badly garbled: `v 202`, `EV 31` (EV-01), `SV-51 … 3 ber` (SV-01 3 bar), `53-501` (SG-301), "vaamruk" (voordruk). **No connections** at all → dev-19 (which valve between buffer and 3-way valve) impossible; dev-20/21 unreliable |

**Scorecard vs Claude vision**

| Page type | Docling + RapidOCR | Haiku vision | Use |
|---|---|---|---|
| Normal text | ✅ | – | Docling (free) |
| Scanned tables | ✅ with O/0, I/1 errors | ✅ | Docling + code normalisation |
| Complex/broken tables | ❌ scrambled | ✅ | Vision fallback |
| Icons | ❌ empty | ✅ | Haiku |
| P&ID | ❌ garbled, no connections | ✅ | Haiku (full drawing + crops) |
| Speed | ~4 s/page (CPU) | ~14 s/page | |
| Cost | $0 | ~$0.002/page | |

**Conclusion:** Option B routing is confirmed by evidence, not opinion.

**Docling JSON (what the ingest code will read, not the markdown)**
- `pages` (one per PDF page), `texts`, `tables`, `pictures`, `groups`.
- Every text/table has `prov[0].page_no` (**PDF page, counted from 1**) and a `bbox` → used for citations.
  Markdown export **loses page numbers**, so ingest must use JSON.
- Text labels: `section_header` (split chunks here), `text`, `list_item`, `caption`, and
  `page_header`/`page_footer` (`content_layer: "furniture"` → drop).
- Tables: `data.grid` = rows × cells → one chunk per table (never split).
- Pictures: position only, no content → candidate pages for vision.

**Ingest rules learned**
1. Read JSON, drop furniture.
2. Drop exact duplicate texts on the same page.
3. Group texts under their `section_header`; tables are their own chunk; keep `page_start`/`page_end`.
4. Normalise error-code tokens (index both `HO` and `H0`, `HI` and `H1`).
5. Send to Haiku vision: pages with icon tables, diagrams, P&ID, and tables that look scrambled.
6. Options names (API): `do_ocr`, `force_ocr`, `ocr_preset` (`auto`/`rapidocr`/…), `page_range` [from, to].
   Results are deleted ~5 min after a job finishes, so fetch them right away.

**Cost note (500 companies × 10,000 docs ≈ 250M pages):** vision on every page ≈ $500k (Haiku) to $10M+ (Opus);
Docling everywhere + Haiku on ~5% of pages ≈ $25k plus CPU/GPU workers. That is the case for page routing.

---

## 6. Decisions so far

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript | Preferred in the brief |
| Architecture | RAG with vision-based ingestion | Cheap and fast per question; vision needed for the hard documents |
| When to run vision | Once, at ingestion | 8–47 s per page is too slow for a technician |
| Citations | PDF page numbers | Matches dev-questions.json |
| Frameworks | Plain TypeScript, no LangChain | Pipeline is simple; easier to debug and explain. LangGraph only if we add an agent loop later |
| Second approach (stretch) | Candidates: Sonnet vs Opus for ingestion; Mistral OCR vs Claude vision; RAG vs full-context | Brief asks for a comparison with numbers |

### Final architecture choice (decided by the user)

| Part | Choice | Why |
|---|---|---|
| App code | TypeScript only | Brief preference; our code never contains Python |
| Infrastructure | Docker containers: **docling-serve** and **PostgreSQL + pgvector** | Docling's engine is Python, so it runs as a black-box server we call from TS |
| Extraction (text, tables, scan) | **Docling** via `@docling/docling-client` | Free, local, strong on tables and layout, built-in OCR for the scan |
| Extraction (icons, diagrams, P&ID) | **Claude vision** for pages with pictures | OCR reads text but can't describe icons or follow pipes (proven need in Lab 4) |
| Storage | **pgvector**: chunks with `tenant_id`, doc, PDF page, language, text, embedding | Multi-tenant ready ("my tenant"); scales to many companies |
| Search | **Hybrid**: pgvector similarity + Postgres full-text search | Embeddings for vague/multilingual questions, keywords for exact codes (E47, V-202) |
| OCR (scan) | **PaddleOCR** models (preferably through Docling's RapidOCR engine, which runs PaddleOCR models, so no extra service is needed) | Free, strong OCR; user's choice over paying Claude for scanned text |
| Embeddings | **BGE-M3** (1024 dims, 100+ languages, long chunks up to 8k tokens), run locally | Free, strong multilingual retrieval (NL/FR question vs EN doc) |
| Reranker | **BGE Reranker v2 M3** cross-encoder on the top ~20–30 hits, run locally | Same family as BGE-M3, multilingual; puts the exact right chunk (e.g. 8kW row) first. Kept only if the eval shows it helps |
| How to run them | Transformers.js in Node if ONNX versions load well; otherwise Hugging Face text-embeddings-inference (TEI) in Docker | Verify in the embeddings lab; TEI is faster on CPU |
| Answer model | Configurable: Haiku 5.5 vs Sonnet 5.5, decided by eval numbers | Haiku is ~20× cheaper; must prove it handles traps and abstention |
| Answering | Claude with structured output: answer + citations + `abstained` flag | Grounding + honest abstention |
| Evaluation | One TS command over dev-questions.json: correctness, citations, abstention, retrieval recall, measured latency + cost | Trustworthy numbers |

### Page routing (Option B: never send every page to Claude)

| Page type | Processing |
|---|---|
| Normal text pages | Docling |
| Scanned pages | PaddleOCR |
| Error-code tables | Docling, OCR fallback |
| Display icons | Haiku vision |
| Wiring diagrams | OCR + Haiku vision |
| P&ID | OCR + Haiku vision, full drawing **plus cropped regions** (A1 is too large to read when resized); keep crop coordinates for precise citations |

Model choice for vision is **not assumed**: Haiku 5.5 must be tested against the Lab 4 Opus results
(icons, P&ID connections vs. lines that merely cross, small terminal numbers) before we rely on it.

### Evaluation must report
Answer correctness, citation correctness, visual-question accuracy, abstention accuracy, query latency,
and cost split three ways: **ingestion cost (one-time)**, **per-question cost**, and **amortised cost per question**.
Compare: OCR-only vs Option B (OCR + selective vision) vs vision-everywhere.

### Product scope (user decision): multi-tenant web app

A company joins (creates a tenant), uploads its own documents, and gets a chatbot that answers
questions from only its documents.

| Part | Choice |
|---|---|
| Frontend | React (Vite) + shadcn/ui, kept very simple: 1) create/select company, 2) upload documents + see processing status, 3) chat with answers, citations and "not in the documents" |
| Backend API | TypeScript HTTP server: `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /me`; then (tenant from session) `POST /documents` (upload → ingest), `GET /documents` (status), `POST /ask` (streamed answer) |
| Upload | Single PDF **or a ZIP of PDFs** (like the data pack). Server unzips safely: only `.pdf`, size + file-count limits, no paths outside the upload folder (zip-slip), no zip bombs. Each PDF becomes a `documents` row (status `queued`); duplicates skipped by file hash |
| Background processing | Job queue in Postgres (e.g. **pg-boss**, no Redis needed), one job per document, handled by a worker process. Steps: route pages → Docling / PaddleOCR / Haiku vision → chunk → embed (BGE-M3) → store. Status: queued → processing (page x/y) → ready / failed, with retries. Only new documents are processed |
| Chunking | Structure-aware: follow Docling's headings/sections; **never split a table or an error-code row**; vision output for an icon block or P&ID crop = its own chunk; ~300–800 tokens with small overlap for long prose; every chunk keeps tenant_id, document, PDF page(s), language, section title, chunk type (text / table / figure) |
| Isolation | Every table has `tenant_id`; every query filters on it |
| Auth | **Simple email + password** (user decision). Sign up creates a company (tenant) + its first user. Passwords hashed with `scrypt` (Node built-in), login sets an httpOnly session cookie, sessions stored in Postgres. **The tenant is always taken from the logged-in session, never from the URL or request body**, so one company can never read another's data. No roles, password reset or SSO (README: next steps) |
| Order | Build after the core (ingest, ask, eval) works, so the web app reuses the same functions; the CLI stays for the debrief and the eval |

Brief check: a UI is "not required" and auth/multi-tenancy are "out of scope", so this is extra.
It also covers two stretch goals: streaming answers and adding a document without re-processing everything.

Note: the brief puts multi-tenancy out of scope; a `tenant_id` column is a cheap way to show the design is ready for "500 companies".

---

## 7. Progress

| Phase | Status |
|---|---|
| Phase 0 — understand the data (Labs 1–2) | ✅ Done |
| Lab 3 — project setup | ✅ Done |
| Lab 4 — prove vision transcription | ✅ Done |
| Lab 5 — Haiku vision test | 🔄 Icons done; P&ID test still to run |
| Lab 6 — Docker + Postgres/pgvector + schema (7 tables, tenant_id) | ✅ Done |
| Lab 7 — Docling + RapidOCR container and test (4 documents) | ✅ Done |
| Next — ingest: Docling JSON → chunks in Postgres (with tenant_id) | ⏳ |
| Lab 6 — chunking + search index (the "R") | ⏳ |
| Lab 7 — ask command: retrieve → answer + citations / abstain (the "A + G") | ⏳ |
| Lab 8 — evaluation report | ⏳ |
| Lab 9 — README + debrief prep | ⏳ |
