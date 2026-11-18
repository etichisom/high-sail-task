// Answer a technician's question from the manuals:
// hybrid search → the best chunks go to Claude → answer with page citations, or "not in the manuals".
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { config } from "../config.js";
import { pool } from "../db.js";
import { hybridSearch } from "../retrieval/hybrid-search.js";
import { rerank } from "../retrieval/rerank.js";

export type Citation = { filename: string; pageStart: number; pageEnd: number };

export type AskResult = {
  answer: string;
  evidence: string; // the exact source lines the answer rests on (empty when abstained)
  language: string;
  abstained: boolean; // true = the manuals don't contain the answer
  citations: Citation[];
  searches: string[]; // extra searches Claude made with the search tool (empty = the first results were enough)
  retrieved: Citation[]; // every chunk search found (in order), so the eval can check the search on its own
  latencyMs: number; // whole question: search + Claude
  searchMs: number;
  // Where the time went, summed over all searches and turns (to find what makes an answer slow)
  timings: { searchMs: number; rerankMs: number; claudeMs: number; claudeTurns: number };
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null; // null = no price known for this model
};

// Dollars per million tokens (Claude API price list), to report the cost of every question
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

// The eval uses this too, for the judge's cost. null = no price known for this model
export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
}

const MAX_SEARCHES = config.answerMaxSearches;

// The rules. The same text every time, so it never depends on the question.
const SYSTEM_PROMPT = `You answer questions from field technicians about heat pumps and plant rooms.
Use ONLY the numbered sources you are given. They are excerpts from the technician's manuals (English, Dutch and French).
- First write the language of the question in "language" (en, nl or fr). Then write "answer" in exactly that language, even when the sources are in another language.
- Be short and practical: the technician is on site. For a fault code, give its meaning and every check or step in order, including what to replace at the end.
- Every fact must come from a source. List the numbers of the sources you used in "sources".
- If several components fit the question (e.g. two 3-way valves next to a buffer tank, or the same setting on different models), do not pick one: give the answer for each, naming the component or model.
- If the question names the equipment (brand, model or unit), answer ONLY from that manual. If that manual does not cover it, abstain: never offer another brand's values instead, even with a warning.
- Say which manual (brand/document) your answer comes from. If the question does not name the equipment and the answer depends on the installation, check the other manuals too (search_manuals) and answer per manual, naming each; include the installation drawings (P&ID) for questions about plant-room components.
- In "evidence", copy word for word the line(s) or table row(s) from the sources that contain the key values of your answer. If you cannot copy such a line, you do not have the answer.
- Check the label of each value: it must mean what was asked. A nearby value with a different label (a set point instead of a minimum, MCA instead of a breaker rating, another model's column) is not the answer: search again with the exact term in the manual's language.
- If the question asks several things, your evidence needs a value for each. For a missing part, search again before saying it is not covered.
- Technicians use field words; manuals use their own terms. Use your technical knowledge ONLY to match the two (e.g. "breaker size" = max fuse/breaker amps (MFA), "wire gauge" = wiring size (AWG), "48 MBH" fits a model column "41/48/55", "debiet" = flow rate). Values always come from the sources, never from your own knowledge.
- Tables can lose their column headers when extracted. If a page appears twice (a table and a "vision" transcription of the same page), prefer the one with clear headers. Match model sizes and names carefully (e.g. a 48 MBH unit, an 8 kW unit).
- If the sources do not contain the answer, use the search_manuals tool with different words before giving up. Pick the manual that fits the question from the list (the file name shows brand and language: -en, -nl, -fr) and search in THAT manual's language, with its terms, exact codes, model names or component tags. You can search ${MAX_SEARCHES} times.
- If the sources still do not contain the specific fact asked for, set "abstained" to true, say in one sentence (in the question's language) that the manuals do not cover it, and leave "sources" empty. Sources about the same topic without that fact are not enough. Never guess or use general knowledge.`;

// Structured output: Claude must reply with exactly this JSON shape, so we never parse free text
const ANSWER_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  properties: {
    language: { type: "string", enum: ["en", "nl", "fr"] },
    evidence: { type: "string" },
    answer: { type: "string" },
    sources: { type: "array", items: { type: "integer" } },
    abstained: { type: "boolean" },
  },
  required: ["language", "evidence", "answer", "sources", "abstained"],
  additionalProperties: false,
});

// The tool Claude can call to search again. Our code runs the search; Claude only chooses the words.
const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_manuals",
  description:
    "Search this company's manuals again with different words. Use it when the sources so far do not contain the answer. " +
    "Write the query the way the manual would say it: in English, Dutch or French, with exact codes, model names or tags. " +
    "Returns new numbered sources.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "The search words, e.g. 'veiligheidsklep primair openingsdruk'" } },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment (.env)

type Hit = Awaited<ReturnType<typeof hybridSearch>>[number];

// Hybrid search (~40 candidates) → reranker → the best few, as numbered sources.
// `known` holds every chunk already shown to Claude, so a new search only adds new chunks.
async function findSources(
  tenantId: string,
  query: string,
  known: Hit[],
  timings: AskResult["timings"],
  candidateCount = config.rerankCandidates,
): Promise<string> {
  let t = Date.now();
  const candidates = await hybridSearch(tenantId, query, candidateCount);
  timings.searchMs += Date.now() - t;
  const fresh = candidates.filter((hit) => !known.some((k) => k.id === hit.id));
  t = Date.now();
  const best = await rerank(query, fresh, config.answerSources);
  timings.rerankMs += Date.now() - t;
  const first = known.length;
  known.push(...best);
  if (best.length === 0) return "No new sources found.";
  return best
    .map((hit, i) => {
      const pages = hit.pageStart === hit.pageEnd ? `${hit.pageStart}` : `${hit.pageStart}-${hit.pageEnd}`;
      return `<source id="${first + i + 1}" document="${hit.filename}" pages="${pages}" section="${hit.section ?? ""}">\n${hit.content}\n</source>`;
    })
    .join("\n\n");
}

export async function ask(tenantId: string, question: string): Promise<AskResult> {
  const started = Date.now();

  // 1. Retrieve + 2. Augment: the best chunks for the question, numbered so Claude can cite them
  const hits: Hit[] = [];
  const timings: AskResult["timings"] = { searchMs: 0, rerankMs: 0, claudeMs: 0, claudeTurns: 0 };
  const sources = await findSources(tenantId, question, hits, timings);
  const searchMs = Date.now() - started;

  // 3. Generate, as a small agent: Claude answers, or first calls search_manuals with other words.
  // Each search's results go back to Claude. After MAX_SEARCHES the tool replies "answer now".
  // (The tool list must stay the same every turn: Claude's thinking is tied to it.)
  // Which manuals exist, so Claude can aim a new search at the right one, in that manual's language
  const documents = await pool.query<{ filename: string }>(
    "SELECT filename FROM documents WHERE tenant_id = $1 AND status = 'ready' ORDER BY filename",
    [tenantId],
  );
  const manuals = documents.rows.map((row) => `- ${row.filename}`).join("\n");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Manuals of this company:\n${manuals}\n\n${sources}\n\nQuestion: ${question}` },
  ];
  const searches: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 0; turn <= MAX_SEARCHES + 2; turn++) {
    const claudeStarted = Date.now();
    const response = await client.messages.parse({
      model: config.answerModel,
      max_tokens: 16000,
      output_config: { effort: config.answerEffort as "low" | "medium" | "high", format: ANSWER_FORMAT },
      system: SYSTEM_PROMPT,
      tools: [SEARCH_TOOL],
      // After the last allowed search, Claude may not call the tool any more: it has to answer.
      // (The tool stays in the list; changing the list would break Claude's thinking between turns.)
      ...(searches.length >= MAX_SEARCHES ? { tool_choice: { type: "none" as const } } : {}),
      messages,
    });
    timings.claudeMs += Date.now() - claudeStarted;
    timings.claudeTurns++;
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") throw new Error("Claude declined to answer this question");

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const query = String((block.input as { query?: unknown }).query ?? "");
        if (searches.length >= MAX_SEARCHES) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: "No more searches. Answer now with the sources you have, or abstain." });
          continue;
        }
        searches.push(query);
        results.push({ type: "tool_result", tool_use_id: block.id, content: await findSources(tenantId, query, hits, timings, config.rerankCandidatesExtra) });
      }
      messages.push({ role: "user", content: results }); // all results of one turn in one message
      continue;
    }

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

    return {
      answer: output.answer,
      evidence: output.evidence,
      language: output.language,
      abstained: output.abstained,
      citations,
      searches,
      retrieved: hits.map((hit) => ({ filename: hit.filename, pageStart: hit.pageStart, pageEnd: hit.pageEnd })),
      latencyMs: Date.now() - started,
      searchMs,
      timings,
      inputTokens,
      outputTokens,
      costUsd: costUsd(config.answerModel, inputTokens, outputTokens),
    };
  }
  throw new Error("Claude kept searching instead of answering");
}
