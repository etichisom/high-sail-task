// Run all dev questions and report quality, latency and cost.
// Usage: npm run eval -- --tenant <company name> [--questions data/dev-questions.json] [--only dev-03,dev-17] [--runs 3]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { pool } from "../db.js";
import { evaluateQuestion, type EvalQuestion, type EvalRow } from "../eval/evaluate.js";
import { findTenant } from "../tenants.js";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    questions: { type: "string", default: "data/dev-questions.json" },
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

let questions: EvalQuestion[] = JSON.parse(readFileSync(values.questions, "utf8"));
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
console.log(`\n${runs > 1 ? `run ${run}/${runs}\n` : ""}id      ok  search cite  abst  time    cost      question`);
for (const q of questions) {
  try {
    const row = await evaluateQuestion(tenantId, q);
    rows.push(row);
    const mark = (value: boolean | null) => (value === null ? "-" : value ? "yes" : "NO").padEnd(5);
    const cost = row.answerCostUsd === null ? "?" : `$${row.answerCostUsd.toFixed(5)}`;
    console.log(
      `${row.id}  ${row.correct ? "✓" : "✗"}   ${mark(row.retrievalHit)}  ${mark(row.citationHit)} ${mark(row.abstainedCorrectly)} ${(row.latencyMs / 1000).toFixed(1).padStart(5)}s  ${cost.padEnd(8)}  ${q.question.slice(0, 50)}`,
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

// Totals. Percentages only count questions where the check applies.
const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`);
const answerable = rows.filter((r) => r.answerable);
const unanswerable = rows.filter((r) => !r.answerable);
const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? 0;
const answerCost = rows.reduce((sum, r) => sum + (r.answerCostUsd ?? 0), 0);
const judgeCost = rows.reduce((sum, r) => sum + (r.judgeCostUsd ?? 0), 0);

const total = rows.length + crashed.length; // crashed questions are in the total, so they lower the score

const summary = {
  questions: total,
  crashed,
  correct: percent(rows.filter((r) => r.correct).length, total),
  answerableCorrect: percent(answerable.filter((r) => r.correct).length, answerable.length),
  retrievalHit: percent(answerable.filter((r) => r.retrievalHit).length, answerable.length),
  citationHit: percent(answerable.filter((r) => r.citationHit).length, answerable.length),
  abstentionAccuracy: percent(rows.filter((r) => r.abstainedCorrectly).length, total),
  unanswerableAbstained: percent(unanswerable.filter((r) => r.abstained).length, unanswerable.length),
  latencyP50Ms: p50,
  latencyP90Ms: p90,
  costPerQuestionUsd: rows.length ? answerCost / rows.length : 0,
  judgeCostUsd: judgeCost,
};

console.log(`
Correct answers          ${summary.correct} overall, ${summary.answerableCorrect} of answerable
Search found right page  ${summary.retrievalHit}
Cited right page         ${summary.citationHit}
Abstention correct       ${summary.abstentionAccuracy} (unanswerable abstained: ${summary.unanswerableAbstained})
Latency                  p50 ${(p50 / 1000).toFixed(1)}s, p90 ${(p90 / 1000).toFixed(1)}s
Cost per question        $${summary.costPerQuestionUsd.toFixed(5)} (judge, eval only: $${judgeCost.toFixed(4)} total)`);

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
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const settings = { answerModel: config.answerModel, answerEffort: config.answerEffort, answerSources: config.answerSources, judgeModel: config.judgeModel, runs };
writeFileSync(file, JSON.stringify({ settings, summary, rows }, null, 2));
console.log(`\nreport: ${file}`);

await pool.end();


// npm run -s eval -- --tenant demo --questions data/holdout-questions.json