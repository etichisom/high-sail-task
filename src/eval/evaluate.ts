// Evaluate one question: ask it like a technician would, then score the result against the reference.
// Four checks: did search find the right page, did the answer cite it, is the answer correct, abstain or not.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { ask, costUsd, type Citation } from "../answer/ask.js";
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
  retrievalHit: boolean | null; // a right page was among the retrieved chunks (null = nothing to find)
  citationHit: boolean | null; // a right page was among the citations (null = nothing to find)
  correct: boolean; // the judge's verdict (for unanswerable questions: did it abstain)
  judgeReason: string;
  answer: string;
  citations: Citation[];
  searches: string[]; // extra searches the answer agent made
  latencyMs: number;
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

const JUDGE_PROMPT = `You grade answers from a question-answering system for heat-pump technicians.
You get the question, a reference answer written by an expert, and the system's answer.
The answer is correct when it gives the key facts of the reference answer (values, codes, steps that matter) and contradicts none of them.
Extra correct details are fine. A different language than the reference is fine. Missing the key fact, a wrong value, or "not covered" when the reference has an answer is incorrect.
Give a one-sentence reason.`;

const JUDGE_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  properties: {
    reason: { type: "string" },
    correct: { type: "boolean" },
  },
  required: ["reason", "correct"],
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
    answer: result.answer,
    citations: result.citations,
    searches: result.searches,
    latencyMs: result.latencyMs,
    answerCostUsd: result.costUsd,
  };

  // Unanswerable: the only right thing is to abstain, no judge needed
  if (!q.answerable) {
    return {
      ...base,
      retrievalHit: null,
      citationHit: null,
      correct: result.abstained,
      judgeReason: result.abstained ? "abstained as expected" : "answered a question the manuals do not cover",
      judgeCostUsd: 0,
    };
  }

  // Answerable but abstained: wrong, no judge needed either
  const retrievalHit = result.retrieved.some((found) => matches(found, q.sources));
  const citationHit = result.citations.some((found) => matches(found, q.sources));
  if (result.abstained) {
    return { ...base, retrievalHit, citationHit, correct: false, judgeReason: "abstained, but the manuals cover it", judgeCostUsd: 0 };
  }

  const verdict = await judge(q, result.answer);
  return { ...base, retrievalHit, citationHit, correct: verdict.correct, judgeReason: verdict.reason, judgeCostUsd: verdict.costUsd };
}