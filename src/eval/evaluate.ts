// Evaluate one question: ask it like a technician would, then score the result against the reference.
// Four checks: did search find the right page, did the answer cite it, is the answer correct, abstain or not.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { ask, costUsd, type AskResult, type Citation } from "../answer/ask.js";
import { config } from "../config.js";

// One entry of data/dev-questions.json
export type EvalQuestion = {
  id: string;
  question: string;
  language: string;
  answerable: boolean;
  reference_answer: string;
  sources: { doc: string; pages: number[] }[];
};

export type EvalRow = {
  id: string;
  question: string;
  answerable: boolean;
  abstained: boolean;
  abstainedCorrectly: boolean; // abstained exactly when the question is not answerable
  answerLanguage: string; // the language of the answer TEXT, detected here (en, nl, fr), not Claude's own label
  languageMatch: boolean | null; // answered in the question's language (null = the question file gives no language)
  retrievalHit: boolean | null; // a right page was among the retrieved chunks (null = nothing to find)
  citationHit: boolean | null; // a right page was among the citations (null = nothing to find)
  citationNear: boolean | null; // a citation is the right document and within 1 page of a right page
  verdict: "correct" | "partial" | "wrong"; // the judge's grade (unanswerable questions: correct = abstained)
  correct: boolean; // verdict === "correct": only fully correct answers count
  numbersFound: { found: number; total: number } | null; // exact check: numbers of the reference found in the answer
  judgeReason: string;
  answer: string;
  citations: Citation[];
  searches: string[]; // extra searches the answer agent made
  timings: AskResult["timings"]; // where the time went (search, Claude)
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  answerCostUsd: number | null;
  judgeCostUsd: number | null;
};

// Does this chunk (document + page range) contain one of the expected pages?
function matches(found: Citation, expected: EvalQuestion["sources"]): boolean {
  return expected.some(
    (source) =>
      source.doc === found.filename && source.pages.some((page) => page >= found.pageStart && page <= found.pageEnd),
  );
}

// Like matches(), but one page off is fine (a fact at the bottom of a page, a table running over two pages)
function near(found: Citation, expected: EvalQuestion["sources"]): boolean {
  return expected.some(
    (source) =>
      source.doc === found.filename && source.pages.some((page) => page >= found.pageStart - 1 && page <= found.pageEnd + 1),
  );
}

// The exact check next to the judge: which numbers of the reference answer (values like 35, 1.5, 0.25) appear in the
// answer? Decimal commas count as dots ("1,5" = "1.5"). Single digits are skipped: they are often step numbers.
function numbers(text: string): string[] {
  return [...text.replace(/(\d),(\d)/g, "$1.$2").matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => String(Number(m[0])))
    .filter((n) => n.length > 1 || n.includes("."));
}

function numberCheck(reference: string, answer: string): EvalRow["numbersFound"] {
  const expected = [...new Set(numbers(reference))];
  if (expected.length === 0) return null;
  const given = new Set(numbers(answer));
  return { found: expected.filter((n) => given.has(n)).length, total: expected.length };
}

// Which language is this text in? Counts common words that belong to one of the three languages only.
// Checked on the answer itself, so the eval does not just trust the language Claude says it used.
const LANGUAGE_WORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "with", "this", "check", "if", "are", "not", "for", "from", "it", "when", "then", "or"],
  nl: ["het", "een", "van", "niet", "controleer", "wordt", "bij", "voor", "zijn", "met", "als", "dat", "deze", "naar", "de", "of", "en", "dan"],
  fr: ["le", "la", "les", "des", "une", "est", "pas", "pour", "vérifiez", "avec", "dans", "sur", "du", "et", "ce", "si", "ou"],
};

export function detectLanguage(text: string): string {
  const words = text.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ]+/g) ?? [];
  let best = "";
  let bestScore = 0;
  for (const [language, list] of Object.entries(LANGUAGE_WORDS)) {
    const score = words.filter((w) => list.includes(w)).length;
    if (score > bestScore) [best, bestScore] = [language, score];
  }
  return best;
}

const JUDGE_PROMPT = `You grade answers from a question-answering system for heat-pump technicians.
You get the question, a reference answer written by an expert, and the system's answer.
Grade it:
- "correct": it gives the key facts of the reference answer (values, codes, steps that matter) and contradicts none of them.
- "partial": it gives some key facts but misses others (e.g. one of two values, part of the steps), with nothing wrong.
- "wrong": it misses the key fact, gives a wrong value, or says "not covered" when the reference has an answer.
Extra correct details are fine. A different language than the reference is fine.
Give a one-sentence reason.`;

const JUDGE_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  properties: {
    reason: { type: "string" },
    verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
  },
  required: ["reason", "verdict"],
  additionalProperties: false,
});

const client = new Anthropic();

async function judge(q: EvalQuestion, answer: string) {
  const response = await client.messages.parse({
    model: config.judgeModel,
    max_tokens: 16000,
    output_config: { effort: "low", format: JUDGE_FORMAT },
    system: JUDGE_PROMPT,
    messages: [
      {
        role: "user",
        content: `Question: ${q.question}\n\nReference answer: ${q.reference_answer}\n\nSystem answer: ${answer}`,
      },
    ],
  });
  const verdict = response.parsed_output;
  if (!verdict) throw new Error(`Judge gave no valid verdict (stop reason: ${response.stop_reason})`);
  const { input_tokens, output_tokens } = response.usage;
  return { ...verdict, costUsd: costUsd(config.judgeModel, input_tokens, output_tokens) };
}

export async function evaluateQuestion(tenantId: string, q: EvalQuestion): Promise<EvalRow> {
  const result = await ask(tenantId, q.question);

  const base = {
    id: q.id,
    question: q.question,
    answerable: q.answerable,
    abstained: result.abstained,
    abstainedCorrectly: result.abstained === !q.answerable,
    answerLanguage: detectLanguage(result.answer),
    languageMatch: q.language ? detectLanguage(result.answer) === q.language : null,
    answer: result.answer,
    citations: result.citations,
    searches: result.searches,
    timings: result.timings,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    answerCostUsd: result.costUsd,
  };

  // Unanswerable: the only right thing is to abstain, no judge needed
  if (!q.answerable) {
    return {
      ...base,
      retrievalHit: null,
      citationHit: null,
      citationNear: null,
      verdict: result.abstained ? "correct" : "wrong",
      correct: result.abstained,
      numbersFound: null,
      judgeReason: result.abstained ? "abstained as expected" : "answered a question the manuals do not cover",
      judgeCostUsd: 0,
    };
  }

  // Answerable but abstained: wrong, no judge needed either
  const retrievalHit = result.retrieved.some((found) => matches(found, q.sources));
  const citationHit = result.citations.some((found) => matches(found, q.sources));
  const citationNear = result.citations.some((found) => near(found, q.sources));
  const numbersFound = numberCheck(q.reference_answer, result.answer);
  const checks = { retrievalHit, citationHit, citationNear, numbersFound };
  if (result.abstained) {
    return { ...base, ...checks, verdict: "wrong", correct: false, judgeReason: "abstained, but the manuals cover it", judgeCostUsd: 0 };
  }

  const graded = await judge(q, result.answer);
  return {
    ...base,
    ...checks,
    verdict: graded.verdict,
    correct: graded.verdict === "correct",
    judgeReason: graded.reason,
    judgeCostUsd: graded.costUsd,
  };
}