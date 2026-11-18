// Run all dev questions and report quality, latency and cost.
// Usage: npm run eval -- --tenant <company name> [--questions data/dev-questions.json] [--only dev-03,dev-17]
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
  },
});
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

console.log(`${questions.length} questions · answer model ${config.answerModel} (effort ${config.answerEffort}) · judge ${config.judgeModel}\n`);
console.log("id      ok  search cite  abst  time    cost      question");

// One question at a time: latency is measured the way one technician would see it
const rows: EvalRow[] = [];
for (const q of questions) {
  try {
    const row = await evaluateQuestion(tenantId, q);
    rows.push(row);
    const mark = (value: boolean | null) => (value === null ? "-" : value ? "yes" : "NO").padEnd(5);
    const cost = row.answerCostUsd === null ? "?" : `$${row.answerCostUsd.toFixed(5)}`;
    console.log(
      `${row.id}  ${row.correct ? "✓" : "✗"}   ${mark(row.retrievalHit)}  ${mark(row.citationHit)} ${mark(row.abstainedCorrectly)} ${(row.latencyMs / 1000).toFixed(1).padStart(5)}s  ${cost.padEnd(8)}  ${q.question.slice(0, 50)}`,
    );
    if (!row.correct) console.log(`        → ${row.judgeReason}`);
  } catch (error) {
    console.log(`${q.id}  ERROR ${error instanceof Error ? error.message : String(error)}`);
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

const summary = {
  questions: rows.length,
  correct: percent(rows.filter((r) => r.correct).length, rows.length),
  answerableCorrect: percent(answerable.filter((r) => r.correct).length, answerable.length),
  retrievalHit: percent(answerable.filter((r) => r.retrievalHit).length, answerable.length),
  citationHit: percent(answerable.filter((r) => r.citationHit).length, answerable.length),
  abstentionAccuracy: percent(rows.filter((r) => r.abstainedCorrectly).length, rows.length),
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

// Save everything, so two runs (e.g. Haiku vs Sonnet) can be compared later
const dir = join(config.storeDir, "eval");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const settings = { answerModel: config.answerModel, answerEffort: config.answerEffort, answerSources: config.answerSources, judgeModel: config.judgeModel };
writeFileSync(file, JSON.stringify({ settings, summary, rows }, null, 2));
console.log(`\nreport: ${file}`);

await pool.end();