// Run all dev questions and report quality, latency and cost.
// Usage: npm run eval -- --tenant <company name> [--file data/dev-questions.json] [--only dev-03,dev-17] [--runs 3]
// (--questions is the same as --file)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { pool } from "../db.js";
import { evaluateQuestion, type EvalQuestion, type EvalRow } from "../eval/evaluate.js";
import { fmt, parseQuestions, summarize } from "../eval/summary.js";
import { findTenant } from "../tenants.js";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    file: { type: "string" },
    questions: { type: "string" },
    only: { type: "string" }, // e.g. "dev-03,dev-17" to rerun a few questions cheaply
    // Claude's answers vary a little per run, so one run can flip a question. Several runs give a fair average.
    runs: { type: "string", default: "1" },
  },
});
const runs = Math.max(1, Number(values.runs));
if (!values.tenant) {
  console.error("Usage: npm run eval -- --tenant <company name> [--questions file.json] [--only dev-01,dev-02]");
  process.exit(1);
}
const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}".`);
  process.exit(1);
}

const file = values.file ?? values.questions ?? "data/dev-questions.json";
let questions: EvalQuestion[];
try {
  questions = parseQuestions(JSON.parse(readFileSync(file, "utf8")));
} catch (error) {
  console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (values.only) {
  const ids = values.only.split(",");
  questions = questions.filter((q) => ids.includes(q.id));
}

console.log(`${questions.length} questions × ${runs} run(s) · answer model ${config.answerModel} (effort ${config.answerEffort}) · judge ${config.judgeModel}`);

// One question at a time: latency is measured the way one technician would see it
const rows: EvalRow[] = [];
const crashed: string[] = []; // questions that threw an error: they count as wrong, not as "left out"
const results = new Map<string, string>(); // per question: "✓✓✗" over the runs
for (let run = 1; run <= runs; run++) {
console.log(`\n${runs > 1 ? `run ${run}/${runs}\n` : ""}id      grade      search cite  abst  time    cost      question`);
for (const q of questions) {
  try {
    const row = await evaluateQuestion(tenantId, q);
    rows.push(row);
    const mark = (value: boolean | null) => (value === null ? "-" : value ? "yes" : "NO").padEnd(5);
    const cost = row.answerCostUsd === null ? "?" : `$${row.answerCostUsd.toFixed(5)}`;
    console.log(
      `${row.id}  ${(row.correct ? "✓ " : row.verdict === "partial" ? "~ " : "✗ ") + row.verdict.padEnd(9)}${mark(row.retrievalHit)}  ${mark(row.citationHit)} ${mark(row.abstainedCorrectly)} ${(row.latencyMs / 1000).toFixed(1).padStart(5)}s  ${cost.padEnd(8)}  ${q.question.slice(0, 50)}`,
    );
    if (row.searches.length > 0) console.log(`        searched again: ${row.searches.map((q) => `"${q}"`).join(", ")}`);
    if (!row.correct) console.log(`        → ${row.judgeReason}`);
    results.set(q.id, (results.get(q.id) ?? "") + (row.correct ? "✓" : "✗"));
  } catch (error) {
    crashed.push(q.id);
    results.set(q.id, (results.get(q.id) ?? "") + "E");
    console.log(`${q.id}  ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
}

// Totals: counts with their totals, because the sets are small
const summary = summarize(rows, crashed);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const { abstention: abst, latencyMs: lat, timeSplitMs: split, cost } = summary;

console.log(`
Correct answers          ${fmt(summary.correct)} overall · answerable ${fmt(summary.answerableCorrect)} · partial ${summary.partial.count}
Search found right page  ${fmt(summary.retrievalRecall)}   (retrieval recall)
Cited right page         ${fmt(summary.citationExact)} exact · ${fmt(summary.citationNear)} within ±1 page
Same language as asked   ${fmt(summary.languageMatch)}
Numbers in answers       ${fmt(summary.numbersExact)} of the reference values (exact check)
Abstention               accuracy ${fmt(abst.accuracy)} · precision ${fmt(abst.precision)} · recall ${fmt(abst.recall)}
                         hallucinated ${abst.hallucinated} · abstained wrongly ${abst.falseAbstain}
Latency                  p50 ${sec(lat.p50)} · p95 ${sec(lat.p95)} · max ${sec(lat.max)}
Time per question (avg)  search ${sec(split.search)}, reranker ${sec(split.rerank)}, Claude ${sec(split.claude)} in ${split.claudeTurns.toFixed(1)} turns
Tokens per question      ${summary.tokens.input} in + ${summary.tokens.output} out
Cost per question        $${cost.perQuestionUsd.toFixed(5)} (judge, eval only: $${cost.judgeUsd.toFixed(4)} total · whole run $${cost.totalUsd.toFixed(4)})`);

if (crashed.length > 0) console.log(`Crashed (counted wrong)  ${crashed.join(", ")}`);

// With several runs: which questions always pass, always fail, or flip
if (runs > 1) {
  const flaky = [...results].filter(([, r]) => r.includes("✓") && /[✗E]/.test(r));
  const failing = [...results].filter(([, r]) => !r.includes("✓"));
  console.log(`Always correct           ${[...results].filter(([, r]) => !/[✗E]/.test(r)).length} of ${results.size} questions`);
  console.log(`Flaky (pass sometimes)   ${flaky.map(([id, r]) => `${id} ${r}`).join(", ") || "-"}`);
  console.log(`Always wrong             ${failing.map(([id]) => id).join(", ") || "-"}`);
}

// Save everything, so two runs (e.g. Haiku vs Sonnet) can be compared later
const dir = join(config.storeDir, "eval");
mkdirSync(dir, { recursive: true });
const report = join(dir, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const settings = { answerModel: config.answerModel, answerEffort: config.answerEffort, answerSources: config.answerSources, judgeModel: config.judgeModel, runs };
writeFileSync(report, JSON.stringify({ questionsFile: file, settings, summary, rows }, null, 2));
console.log(`\nreport: ${report}`);

await pool.end();


// npm run -s eval -- --tenant demo --questions data/holdout-questions.json