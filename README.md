# Ask the Manual

**📊 Debrief slides: [docs/slides.pdf](docs/slides.pdf)** · Live demo: [highsail-task.lernie.net](https://highsail-task.lernie.net)

A field technician asks a question about a heat pump or a plant room, in **English, Dutch or French**.
The service answers **in the language of the question**, cites the **document and PDF page** for every fact,
and says **"not in the manuals"** instead of guessing when the documents do not contain the answer.

Built in TypeScript on 9 manuals (585 pages: text manuals, a scanned manual, icon-heavy controller guides,
error-code flowcharts and an A1 P&ID drawing).

| | Result |
|---|---|
| Dev questions (21), 2 runs | **38/42 (90 %)**, right page found and cited 36/36, language 42/42 |
| Self-made test questions (20, written by us and checked against the PDFs, not used for tuning) | **20/20 correct**, all 3 "not covered" refused |
| Hard set (16, written to break it: icons, scans, P&ID, cross-language tables, traps), 2 runs | **30/32 (94 %)**, right page found and cited 24/24 |
| Latency per question (laptop CPU) | p50 **4.5 s**, p95 **8 s** |
| Cost per question | **$0.0016** (Claude Haiku 5.5) |
| One-time ingestion cost | **$0.26** for the whole pack (vision on 231 of 585 pages) |

---

## Screenshots

**Chat**: answer in the question's language, with the manual, page and section it comes from, and the exact source
line ("From the manual"). A follow-up in Dutch is understood from the conversation.

![Chat with citations and evidence](docs/images/chat.png)

**Not in the manuals**: when the documents do not contain the fact, it says so instead of guessing.

![Not in the manuals](docs/images/chat-not-covered.png)

**Documents**: upload PDFs or a ZIP of PDFs; they are processed in the background.

![Documents](docs/images/documents.png)

**Evaluation** (live site, dev set): correctness graded by a separate judge, retrieval and citation checks,
abstention, language, latency and cost; every question opens to show the answer and the judge's reason.

![Evaluation: dev set](docs/images/eval-dev.png)

![Evaluation: per question](docs/images/eval-dev-per-question.png)

**Evaluation of the hard set** (written to break it: icons, scans, the P&ID, cross-language tables, traps):

![Evaluation: hard set](docs/images/eval-hard.png)

## How it works

### Ingestion: once per document, in the background worker

```mermaid
flowchart LR
    U["Upload<br/>PDF or ZIP"] --> Q[("documents table<br/>status: queued")]
    Q --> W["Worker<br/>SKIP LOCKED"]
    W --> D["Docling<br/>layout · tables · OCR"]
    D --> C["Chunker<br/>sections · table rows<br/>with headers · figures"]
    W --> R{"Page routing<br/>icons? drawing?<br/>broken table?"}
    R -- "39 % of pages" --> V["Claude Haiku vision<br/>page → text<br/>(cached by file hash)"]
    R -- "other pages" --> X["text only"]
    C --> E["BGE-M3 embeddings<br/>local, multilingual"]
    V --> E
    E --> P[("Postgres + pgvector<br/>vectors + full-text<br/>tenant_id on every row")]
    P --> OK["status: ready"]
```

### Answering: every question

```mermaid
flowchart LR
    Q["Question<br/>EN · NL · FR"] --> F{"Follow-up?"}
    F -- yes --> RW["Rewrite into a<br/>complete question<br/>(last 3 turns)"]
    F -- no --> S
    RW --> S["Hybrid search<br/>pgvector = meaning<br/>full-text = exact codes<br/>merged with RRF"]
    S -- "best 8 new chunks" --> H["Claude Haiku 5.5<br/>structured answer:<br/>language · evidence ·<br/>answer · sources · abstained"]
    H -- "facts missing?<br/>max 2 extra searches" --> S
    H --> A["Answer streamed<br/>in the question's language"]
    H --> CI["Citations from the real chunks:<br/>document · page · section<br/>+ evidence quote"]
    H --> N["Or: 'Not in the manuals'"]
```

### Where it runs

```mermaid
flowchart LR
    B["Browser<br/>React + shadcn/ui"] -- HTTPS --> CF["Cloudflare<br/>DNS · TLS · proxy"]
    CF --> CA["Caddy on the VPS<br/>Cloudflare IPs only"]
    CA --> API["API + web app<br/>127.0.0.1:3100"]
    API --> DB[("Postgres + pgvector")]
    API -- "uploads queued" --> DB
    WK["Worker"] -- "takes queued docs" --> DB
    WK --> DL["Docling"]
    API --> CL["Claude API<br/>answers · judge"]
    WK --> CL2["Claude API<br/>vision"]
    API -. "shared folder: uploads,<br/>caches, models" .- WK
```

### Ingestion
- **Docling** (Docker) turns each PDF into structured JSON: text, headings, tables, pictures, OCR for the scan.
  Big PDFs are converted in parts of 30 pages (the 180-page De Dietrich manual ran Docling out of memory in one go).
- **Own chunker** on Docling's JSON: one chunk per section, long tables split between rows with the header repeated,
  figure text as separate chunks, duplicate text layers removed. Every chunk starts with the manual's name.
- **Page routing** decides which pages also go to **Claude Haiku vision**: very large pages (the P&ID), pages mostly
  pictures, many tiny text bits (diagram labels), icons read as junk characters, icons inside text (`click " "`),
  tables with an empty column or lost column names. Haiku transcribes the page as markdown: tables with headers that make
  every row self-contained, icons described in words ("suitcase with a clock → holiday schedule activated"),
  P&ID components with tags and data, connections as `TV-201 → V-202 → BT-01`, valve types from their symbols.
  The transcription is split into small chunks under their headings. Results are cached per file hash and prompt version.
- **BGE-M3** embeddings (1024 dims, multilingual) run **locally in Node** (Transformers.js, 8-bit ONNX).

### Answering
- **Hybrid search**: pgvector cosine distance for meaning ("vakantie schema" finds "Holiday schedule") plus Postgres
  full-text (`'simple'` config, any important word, stopwords removed) for exact codes like F12, H62, V-202.
  The two lists are merged with Reciprocal Rank Fusion.
- **The best 8 new chunks** of the merged list go to Claude (chunks it already saw are skipped). A BGE reranker used to
  reorder the 40 candidates first; once the agent was in place it no longer improved the score and tripled the
  latency, so it was removed (see "How each step changed the score").
- **Claude Haiku 5.5** answers with structured output. Rules in the prompt: only use the sources, answer in the question's
  language, copy the evidence line before answering, check that a value's label means what was asked (a set point is not
  a minimum), answer every part of the question, match field words to manual words (breaker = MFA, wire gauge = AWG),
  answer only from the named brand's manual, abstain when the specific fact is missing.
- **Search tool (small agent)**: Claude sees the list of the company's manuals and may search again (max 2 times) with
  better words, in that manual's language. Example: a Dutch question about the French De Dietrich manual is searched
  as "P5 code défaut unité extérieure Alezio".

### Multi-tenant service
- Every table has `tenant_id`; every query filters on it. A company only ever searches its own documents.
- **Login**: sign-up creates a company and its first user; passwords hashed with scrypt; an `HttpOnly; SameSite=Lax`
  session cookie (plus `Secure` when hosted). The company is always taken from the session, never from the request.
  Failed logins are rate-limited.
- **Web app** (React + [shadcn/ui](https://ui.shadcn.com), in `web/`, served by the API at `/`): create an account or
  log in, drag a PDF or ZIP onto the upload box and watch each manual's status, and chat: the answer text streams in
  while Claude writes it (Server-Sent Events), with page citations or a "Not in the manuals" badge.
- **Saved chats and follow-ups**: every question and answer is saved per user (`conversations` / `messages`), listed in
  the sidebar and reopened later. A follow-up ("and the pressure switch, where is it?") is first rewritten by Haiku into
  a complete question for the search, and the last 3 turns go to Claude as context.
- **Upload API** (`npm run api`): `POST /documents` takes a PDF or a ZIP of PDFs (only real PDFs, path tricks refused,
  size limits), `GET /documents` shows status and progress, `POST /ask` and `POST /ask/stream` answer (send `conversationId` for a follow-up),
  `GET /conversations` and `GET/DELETE /conversations/<id>` list, open and delete saved chats,
  `GET/POST /evals` and `GET /evals/<id>` run an eval and follow it.
- **Worker** (`npm run worker`): takes queued documents one at a time and runs Docling → chunks → vision → embeddings.
  A document is `ready` only when every step worked. Duplicate files are skipped (same file hash), so adding one manual
  never re-processes the others. Several workers can run; work left by a crashed worker is picked up again.

---

## Results

### Evaluation (`npm run eval`, or the **Evaluation** page in the web app)
One command runs every question through the real pipeline and reports, as counts ("19/21") because the sets are small:
- **Answer correctness**: Claude Sonnet 5.5 grades each answer against the reference as correct / partial / wrong
  (only "correct" counts), plus an **exact check** of the reference's numbers in the answer (decimal commas accepted).
- **Retrieval recall**: did search find a right page at all? (tells a search failure from an answer failure)
- **Citations**: right document + page cited, exactly and within ±1 page.
- **Abstention**: accuracy, precision and recall, with the number of hallucinated answers and wrong abstentions.
- **Language**: is the answer in the question's language? Detected from the answer text itself, not from Claude's label.
- **Latency** p50 / p95 / max with the time per step (search, Claude), **tokens** and **cost** per question
  from the real token counts (answers and judge separately).

Every run is saved to `store/eval/results-<timestamp>.json`. `--file <questions.json>` runs another set (for example
the debrief's held-out set), `--runs 3` repeats each question and lists flaky ones, `--only dev-03,dev-17` reruns a few.
The **Evaluation page** does the same in the browser: run a set from the server or drop a JSON file in the
`dev-questions.json` format, watch the score fill in while it runs, open each question's answer and the judge's
reason, and download the report.

### Latest full run (dev set, 21 questions, 18 answerable + 3 not covered)

| Metric | Result |
|---|---|
| Correct (judge: correct / partial / wrong) | **19/21** overall, 17/18 answerable, 1 partial (dev-04) |
| Retrieval recall (search found a right page) | **17/18** |
| Cited the right page | 17/18 exact, 17/18 within ±1 page (+ section name and evidence quote) |
| Answered in the question's language | **21/21** (detected from the answer text) |
| Abstention | 20/21 right · precision 2/2 · recall 2/3 · 1 hallucinated (dev-05) · 0 wrong abstains |
| Reference numbers in the answer (exact check) | 36/66: a strict, rough signal (references also list item and step numbers the answer may phrase differently); the judge decides correctness |
| Latency | p50 **4.5 s** · p95 **7.9 s** · max 8.0 s (search 0.2 s, Claude 4.6 s in 1.5 turns) |
| Tokens and cost per question | 12,680 in + 681 out · **$0.0016** (judge for the whole run $0.044) |

### How each step changed the score (dev set, 21 questions)

| Step | Correct | Why |
|---|---|---|
| Baseline: Docling chunks + vector search + Haiku | 38 % | Icons, the P&ID and broken tables are not in the text |
| + Haiku vision on flagged pages | 48 % | Icons and drawings become searchable words |
| + Reranker (40 → 8) | 57 % | The right page moves from #12–#35 to the top |
| + all 9 manuals (De Dietrich converted in parts) | 62 % | Two questions needed the missing manual |
| + search-tool agent, keyword fix, prompt rules | 76 % | Cross-language questions find the right manual |
| + evidence quote, field-word matching | 81 % | Fewer wrong values and wrong abstentions |
| + vision v2 (self-contained table rows, valve types), small vision chunks, manual names, label/part rules | **86–90 %** | Search found the right page in 94–100 % of answerable questions |
| Reranker on vs off (with the agent in place) | **19/21 both** · hard set 29/32 with, **30/32 without** · p50 **11 s → 4.5 s** | The agent's extra searches now do the reranker's job; the reranker was removed |

### Stretch goals

| Goal | What is built |
|---|---|
| Comparison of approaches, with eval numbers | The step table above (baseline 38 % → vision 48 % → reranker 57 % → … → 86–90 %, then reranker on vs off: same score, 2.5× faster, so removed) and the model comparison below (Haiku 90 % vs Sonnet 57 % / 52 % at 12× the cost). Each row is a measured eval run. |
| Citations more precise than a page | Each citation carries the **section, table or figure** it came from (e.g. "16.5.31 Outdoor Defrost Temperature Sensor Abnormality (F43)", "Home screen icons"), and each answer shows the **evidence quote**: the exact source line or table row, copied word for word. |
| Follow-up questions | Saved conversations; a follow-up is rewritten into a complete question for the search, with the last 3 turns as context ("and where is the pressure switch?" after an F12 question). |
| Add a document without re-processing everything | Files are identified by their sha256: an uploaded duplicate is skipped, and Docling and vision results are cached per file hash, so only the new manual is processed. |

### Model choice (measured, not assumed)

Measured while the pipeline still had the reranker (so all three rows are comparable with each other):

| Answer model | Correct | Cost / question | p50 |
|---|---|---|---|
| **Claude Haiku 5.5** | 62 % → 90 % with the agent | **$0.0012** | **10 s** |
| Claude Sonnet 5.5 (same pipeline, no agent) | 57 % | $0.0147 (12×) | 8.7 s |
| Claude Sonnet 5.5 + agent | 52 % (kept searching, 7 crashes before the fix) | $0.063 | 12 s |

The remaining errors came from what the model *sees*, not how smart it is: better retrieval moved the score, a bigger
model did not. Haiku stays the answer model. **Today** (reranker removed, all later fixes in): Haiku scores
**19/21 (90 %)** at **$0.0016** per question and **p50 4.5 s**. The judge is Sonnet 5.5: it gave the same verdict as Opus 5.5 on all
21 questions at half the price.

### Cost

| | Cost |
|---|---|
| Ingestion (one time): Docling + embeddings | $0 (local) |
| Ingestion (one time): Haiku vision, 231 pages | $0.26 (~$0.001 per page) |
| Per question (search local, Haiku 1–3 calls, follow-up rewrite) | $0.0016 |
| Amortised over 1,000 questions | ~$0.0019 per question |

### Latency (laptop CPU, model loaded once)
Average per question: search 0.2 s, Claude 4.6 s (1.5 turns): **p50 4.5 s, p95 7.9 s**, and the answer streams from
the first words. Until the last step a local BGE reranker (cross-encoder) reordered the 40 candidates: it took 7–8 s
on a laptop CPU and 11–31 s on the 4-vCPU server. Measured with the agent in place, removing it kept the score
(dev 19/21 both, hard set 30/32 vs 29/32), so it was removed. If a much larger document set makes search noisier, a
hosted or GPU reranker can come back, decided by the eval.

### Bugs the evaluation found (and fixed)
- **Uploaded manuals were labelled with a hash.** Chunks start with the manual's name so a question that names a brand
  finds its table rows. For files uploaded through the web app the name came from the stored file (`<sha256>.pdf`),
  not from the uploaded name, so search for real uploads was weaker than the eval (run on CLI-loaded data) showed. A
  live eval run caught it (hard-05 wrong on an uploaded account). Fixed: the name now comes from the documents row;
  existing chunks repaired; a fresh upload on the live site was checked. The live eval on that account afterwards:
  dev 19/21, right page found and cited 18/18, p50 4.0 s.
- **A fix that made the eval worse, so it was rolled back.** The EcoFlow cover photo shows unlabelled icons, and vision
  wrote guessed meanings for them. A stricter vision prompt (v3: "only meanings printed on the page") removed the
  guesses, but its re-read described two look-alike icons differently and broke another question. Measured over 2 runs
  each, with the hash fix in place: v2 dev 38/42 + hard 30/32, v3 dev 36/42 + hard 26/32. v2 stays the default;
  v3 is kept behind `VISION_PROMPT_VERSION=3` for later work.

### Known limits (honest)
- **dev-05 (glycol %)** is labelled "not covered", but the Midea manual says "never exceed 35 %" (PDF p41). The system
  answers that, naming the Midea manual. The label seems to assume a Panasonic installation; the question names no brand.
- **dev-19 (valve between buffer tank and 3-way valve)** is ambiguous: the question names no installation, and the
  P&ID has two 3-way valves next to the buffer tank (TV-201 and MV-401). The reference means V-202 (butterfly valve,
  between TV-201 and the buffer tank); in the latest runs the system finds and cites the right drawing but picks the
  other path (V-401 before mixing valve MV-401). That is a wrong answer, the kind we most want to avoid; earlier
  versions sometimes abstained here instead.
- **dev-04 (H62 steps)** was flaky (sometimes "partial" when it shortened the flow-switch test); correct in all of
  the latest runs.
- **hard-14 (which brand of heat pump is on the roof?)**: the drawing names no brand. The system says so, but adds the
  capacity and refrigerant instead of a clean "not in the manuals", so it counts as not abstaining.
- **Guessed icon meanings in the index**: vision v2 can describe an unlabelled icon (e.g. on a cover photo) with a
  guessed meaning. It caused no wrong answer once the hash fix was in, but it is invented text in the index; a better
  fix than v3 is to record where an icon appears (status bar, menu, cover photo) and only trust labelled ones.
- In a real product the app would know which installation the technician is at; that removes the dev-05 and
  dev-19 ambiguity.

---

## Run it

Requirements: Node 22+ (tested on 26), Docker (give it 8 GB+), `pdftoppm`/`pdfinfo` (poppler) and `unzip`.

```bash
npm install
docker compose up -d                                                  # Postgres + pgvector (5433), Docling (5001)
docker compose exec -T db psql -U manual -d manual < db/schema.sql    # tables (safe to run again)
```

`.env`:
```
DATABASE_URL=postgres://manual:manual@localhost:5433/manual
DOCLING_URL=http://localhost:5001
ANTHROPIC_API_KEY=...
```

### Command line
```bash
npm run ingest -- --tenant demo data/docs/*.pdf     # Docling → chunks (cached per file)
npm run vision -- --tenant demo data/docs/*.pdf     # Haiku vision on flagged pages (cached)
npm run embed  -- --tenant demo                     # BGE-M3 vectors for new chunks
npm run ask    -- --tenant demo "f12 op de buitenunit, wat moet ik checken"
npm run eval   -- --tenant demo                     # dev questions; add --runs 3 or --file their-questions.json
```

### Service and web app
```bash
npm run web:install && npm run web:build   # build the React app once (web/dist)
npm run api       # web app + API on http://localhost:3000
npm run worker    # processes uploads in the background
```
Open http://localhost:3000, create an account (this creates your company), upload `manuals.zip`, and ask.
To work on the web app with live reload: `npm run api` and `npm run web:dev` (http://localhost:5173).
A company made with the CLI (like `demo`) gets a login with:
```bash
npm run add-user -- --tenant demo --email you@example.com --password <at least 8 characters>
```
API with curl (log in once, keep the cookie):
```bash
curl -c jar -H "content-type: application/json" -d '{"email":"you@example.com","password":"..."}' http://localhost:3000/auth/login
curl -b jar -F "file=@manuals.zip" http://localhost:3000/documents
curl -b jar -H "content-type: application/json" -d '{"question":"what does H99 mean?"}' http://localhost:3000/ask
```
For local scripts only, `ALLOW_TENANT_HEADER=true npm run api` lets an `X-Tenant: <company>` header pick the company.
Keep it off when hosted, and set `COOKIE_SECURE=true` behind HTTPS.

Settings (models, candidates, effort, limits) are in `src/config.ts` and can be changed with environment variables.

### Running new questions (for example a held-out set)
Start the database first (`docker compose up -d`), then from the project folder:

```bash
# one question: answer, sources (document + page), time and cost
npm run ask -- --tenant demo "f12 op de buitenunit, wat moet ik checken"

# a question file in the dev-questions.json format: per-question table + summary, report saved in store/eval/
npm run eval -- --tenant demo --file their-questions.json

# every question 3 times (stability), or only a few questions again
npm run eval -- --tenant demo --file their-questions.json --runs 3
npm run eval -- --tenant demo --file their-questions.json --only q-03,q-07

# questions without reference answers (one per line in a text file): answer them one by one
while IFS= read -r q; do npm run -s ask -- --tenant demo "$q"; echo "-----"; done < their-questions.txt
```

The question file needs `question` and `answerable` (true/false) per question, and `reference_answer` when it is
answerable; `id`, `language` and `sources` (doc + pages) are optional. With `sources`, the report also checks whether
search found and the answer cited the right page. About 3–8 s and ~$0.0035 per question including the judge.

The same works in the browser: **Evaluation** page → drop the JSON file (live at https://highsail-task.lernie.net).

## Project layout
```
src/ingest/      docling.ts (convert, cache, parts) · chunk.ts · needs-vision.ts (routing) · vision.ts · vision-chunks.ts
                 embed-chunks.ts · index.ts (ingestDocument) · pipeline.ts (full ingest for the worker)
src/retrieval/   embed.ts (BGE-M3) · hybrid-search.ts · vector-search.ts
src/answer/      ask.ts (agent, prompt, structured output, citations, cost)
src/eval/        evaluate.ts (scoring + judge) · summary.ts (report, question-file check) · jobs.ts (evals from the web app)
src/api/         server.ts · upload.ts          src/worker/index.ts
src/auth/        passwords.ts (scrypt) · sessions.ts · accounts.ts (sign-up, log-in)
src/chat/        conversations.ts (saved chats, follow-up context)
web/             React + shadcn/ui web app (Vite): src/App.tsx · components/chat-view.tsx · documents-view.tsx · eval-view.tsx · auth-page.tsx
src/cli/         thin entry points for every command
db/schema.sql    tenants, users, sessions, documents, chunks (vector + tsvector), conversations, messages
docs/            inventory.md (documents and why each question is hard) · deploy.md (production setup)
```
