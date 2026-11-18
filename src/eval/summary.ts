// The eval report: totals over all rows, shared by `npm run eval` and the eval page in the web app.
// Every metric is a count with its total ("19 of 21"), because the sets are small: a % alone hides that.
import type { EvalQuestion, EvalRow } from "./evaluate.js";

export type Count = { count: number; total: number }; // total 0 = the check does not apply

export type EvalSummary = {
  questions: number; // including crashed ones
  crashed: string[]; // ids of questions that threw an error: counted as wrong
  correct: Count; // judged fully correct (unanswerable: abstained)
  partial: Count; // judged partly correct (answerable questions only)
  answerableCorrect: Count;
  retrievalRecall: Count; // search found a right page (recall over all retrieved chunks)
  citationExact: Count; // the answer cited a right page
  citationNear: Count; // the answer cited the right document within 1 page
  languageMatch: Count; // answered in the question's language (questions with a language in the file)
  numbersExact: Count; // reference numbers found in the answers (all numbers of all answerable questions)
  abstention: {
    accuracy: Count; // abstained exactly when it should
    precision: Count; // of all abstentions, how many were right (unanswerable)
    recall: Count; // of the unanswerable questions, how many abstained
    hallucinated: number; // answered an unanswerable question
    falseAbstain: number; // abstained although the manuals cover it
  };
  latencyMs: { p50: number; p95: number; max: number; avg: number };
  timeSplitMs: { search: number; claude: number; claudeTurns: number }; // average per question
  tokens: { input: number; output: number }; // average per question
  cost: { perQuestionUsd: number; answersUsd: number; judgeUsd: number; totalUsd: number };
};

const count = (count: number, total: number): Count => ({ count, total });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

export function summarize(rows: EvalRow[], crashed: string[]): EvalSummary {
  const total = rows.length + crashed.length;
  const answerable = rows.filter((r) => r.answerable);
  const unanswerable = rows.filter((r) => !r.answerable);
  const abstained = rows.filter((r) => r.abstained);
  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const avg = (pick: (r: EvalRow) => number) => (rows.length ? rows.reduce((sum, r) => sum + pick(r), 0) / rows.length : 0);
  const answersUsd = rows.reduce((sum, r) => sum + (r.answerCostUsd ?? 0), 0);
  const judgeUsd = rows.reduce((sum, r) => sum + (r.judgeCostUsd ?? 0), 0);
  const withNumbers = answerable.filter((r) => r.numbersFound);

  return {
    questions: total,
    crashed,
    correct: count(rows.filter((r) => r.correct).length, total),
    partial: count(answerable.filter((r) => r.verdict === "partial").length, answerable.length),
    answerableCorrect: count(answerable.filter((r) => r.correct).length, answerable.length),
    retrievalRecall: count(answerable.filter((r) => r.retrievalHit).length, answerable.length),
    citationExact: count(answerable.filter((r) => r.citationHit).length, answerable.length),
    citationNear: count(answerable.filter((r) => r.citationNear).length, answerable.length),
    languageMatch: count(rows.filter((r) => r.languageMatch).length, rows.filter((r) => r.languageMatch !== null).length),
    numbersExact: count(
      withNumbers.reduce((sum, r) => sum + r.numbersFound!.found, 0),
      withNumbers.reduce((sum, r) => sum + r.numbersFound!.total, 0),
    ),
    abstention: {
      accuracy: count(rows.filter((r) => r.abstainedCorrectly).length, total),
      precision: count(abstained.filter((r) => !r.answerable).length, abstained.length),
      recall: count(unanswerable.filter((r) => r.abstained).length, unanswerable.length),
      hallucinated: unanswerable.filter((r) => !r.abstained).length,
      falseAbstain: answerable.filter((r) => r.abstained).length,
    },
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.at(-1) ?? 0,
      avg: Math.round(avg((r) => r.latencyMs)),
    },
    timeSplitMs: {
      search: Math.round(avg((r) => r.timings.searchMs)),
      claude: Math.round(avg((r) => r.timings.claudeMs)),
      claudeTurns: avg((r) => r.timings.claudeTurns),
    },
    tokens: { input: Math.round(avg((r) => r.inputTokens)), output: Math.round(avg((r) => r.outputTokens)) },
    cost: {
      perQuestionUsd: rows.length ? answersUsd / rows.length : 0,
      answersUsd,
      judgeUsd,
      totalUsd: answersUsd + judgeUsd,
    },
  };
}

// "19/21 (90%)"
export function fmt(c: Count): string {
  return c.total === 0 ? "-" : `${c.count}/${c.total} (${Math.round((100 * c.count) / c.total)}%)`;
}

// Checks an uploaded question file. Returns the questions, or throws with a message that says what is wrong.
export function parseQuestions(data: unknown, maxQuestions = 200): EvalQuestion[] {
  const list = Array.isArray(data) ? data : (data as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list) || list.length === 0) throw new Error("the file must be a JSON list of questions");
  if (list.length > maxQuestions) throw new Error(`at most ${maxQuestions} questions per run`);
  const ids = new Set<string>();
  return list.map((item, i) => {
    const q = item as Partial<EvalQuestion> | null;
    const where = `question ${i + 1}`;
    if (!q || typeof q !== "object") throw new Error(`${where} is not an object`);
    if (typeof q.question !== "string" || q.question.trim() === "") throw new Error(`${where} has no "question"`);
    if (q.question.length > 2000) throw new Error(`${where} is longer than 2000 characters`);
    if (typeof q.answerable !== "boolean") throw new Error(`${where} needs "answerable": true or false`);
    if (q.answerable && (typeof q.reference_answer !== "string" || q.reference_answer.trim() === "")) {
      throw new Error(`${where} is answerable, so it needs a "reference_answer"`);
    }
    const id = typeof q.id === "string" && q.id.trim() !== "" ? q.id.trim() : `q-${String(i + 1).padStart(2, "0")}`;
    if (ids.has(id)) throw new Error(`the id "${id}" is used twice`);
    ids.add(id);
    const sources = Array.isArray(q.sources)
      ? q.sources
          .filter((s) => s && typeof s.doc === "string" && Array.isArray(s.pages))
          .map((s) => ({ doc: s.doc, pages: s.pages.filter((p) => Number.isInteger(p)) }))
      : [];
    return {
      id,
      question: q.question.trim(),
      language: typeof q.language === "string" ? q.language : "",
      answerable: q.answerable,
      reference_answer: typeof q.reference_answer === "string" ? q.reference_answer : "",
      sources,
    };
  });
}
