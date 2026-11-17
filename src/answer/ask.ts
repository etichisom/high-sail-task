// Answer a technician's question from the manuals:
// hybrid search → the best chunks go to Claude → answer with page citations, or "not in the manuals".
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { config } from "../config.js";
import { hybridSearch } from "../retrieval/hybrid-search.js";

export type Citation = { filename: string; pageStart: number; pageEnd: number };

export type AskResult = {
  answer: string;
  language: string;
  abstained: boolean; // true = the manuals don't contain the answer
  citations: Citation[];
  latencyMs: number; // whole question: search + Claude
  searchMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null; // null = no price known for this model
};

// Dollars per million tokens (Claude API price list), to report the cost of every question
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

// The rules. The same text every time, so it never depends on the question.
const SYSTEM_PROMPT = `You answer questions from field technicians about heat pumps and plant rooms.
Use ONLY the numbered sources you are given. They are excerpts from the technician's manuals.
- First write the language of the question in "language" (en, nl or fr). Then write "answer" in exactly that language, even when the sources are in another language.
- Be short and practical: the technician is on site.
- Every fact must come from a source. List the numbers of the sources you used in "sources".
- If the sources do not contain the answer, set "abstained" to true, say in one sentence (in the question's language) that the manuals do not cover it, and leave "sources" empty. Never guess or use general knowledge.`;

// Structured output: Claude must reply with exactly this JSON shape, so we never parse free text
const ANSWER_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  properties: {
    language: { type: "string", enum: ["en", "nl", "fr"] },
    answer: { type: "string" },
    sources: { type: "array", items: { type: "integer" } },
    abstained: { type: "boolean" },
  },
  required: ["language", "answer", "sources", "abstained"],
  additionalProperties: false,
});

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment (.env)

export async function ask(tenantId: string, question: string): Promise<AskResult> {
  const started = Date.now();

  // 1. Retrieve: the best chunks of this company's manuals
  const hits = await hybridSearch(tenantId, question, config.answerSources);
  const searchMs = Date.now() - started;

  // 2. Augment: number the chunks, so Claude can cite them as 1, 2, 3…
  const sources = hits
    .map((hit, i) => {
      const pages = hit.pageStart === hit.pageEnd ? `${hit.pageStart}` : `${hit.pageStart}-${hit.pageEnd}`;
      return `<source id="${i + 1}" document="${hit.filename}" pages="${pages}" section="${hit.section ?? ""}">\n${hit.content}\n</source>`;
    })
    .join("\n\n");

  // 3. Generate: Claude answers from the sources only
  const response = await client.messages.parse({
    model: config.answerModel,
    max_tokens: 16000,
    output_config: {
      effort: config.answerEffort as "low" | "medium" | "high",
      format: ANSWER_FORMAT,
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${sources}\n\nQuestion: ${question}` }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to answer this question");
  const output = response.parsed_output;
  if (!output) throw new Error(`No valid answer from Claude (stop reason: ${response.stop_reason})`);

  // 4. Turn source numbers back into document + pages; skip unknown numbers and duplicates
  const citations: Citation[] = [];
  for (const number of output.sources) {
    const hit = hits[number - 1];
    if (!hit) continue;
    const seen = citations.some(
      (c) => c.filename === hit.filename && c.pageStart === hit.pageStart && c.pageEnd === hit.pageEnd,
    );
    if (!seen) citations.push({ filename: hit.filename, pageStart: hit.pageStart, pageEnd: hit.pageEnd });
  }

  const { input_tokens, output_tokens } = response.usage;
  const price = PRICES[config.answerModel];
  return {
    answer: output.answer,
    language: output.language,
    abstained: output.abstained,
    citations,
    latencyMs: Date.now() - started,
    searchMs,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    costUsd: price ? (input_tokens * price.input + output_tokens * price.output) / 1_000_000 : null,
  };
}