// Answer a technician's question from the manuals:
// hybrid search → the best chunks go to Claude → answer with page citations, or "not in the manuals".
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { config } from "../config.js";
import { pool } from "../db.js";
import { hybridSearch } from "../retrieval/hybrid-search.js";
import { rerank } from "../retrieval/rerank.js";

// section: the heading, table or figure the chunk came from (more precise than the page alone)
export type Citation = { filename: string; pageStart: number; pageEnd: number; section?: string };

// Progress steps, sent while a question is being answered, so a web page can show what is happening.
// They carry no answer data: the full result comes at the end, from ask() itself.
export type AskEvent =
  | { type: "searching" } // the first search of the manuals is starting
  | { type: "searching_again"; query: string } // Claude asked for another search with these words
  | { type: "thinking" } // Claude is reading the sources and writing the answer
  | { type: "answer_delta"; text: string } // the next piece of the answer text, while Claude writes it
  | { type: "answer_reset" }; // the text so far was not the answer (Claude searched instead): clear it

// An earlier question and answer in the same conversation, so a follow-up ("and on the outdoor unit?") makes sense
export type Turn = { question: string; answer: string };

// Claude writes its answer as JSON: {"language": "...", "evidence": "...", "answer": "...", ...}.
// This reads that JSON while it streams in and returns the new characters of the "answer" value,
// so the page can show the answer while it is written. The full JSON is still checked at the end.
export class AnswerTextReader {
  private json = "";
  private pos = -1; // where we are inside the answer string; -1 = not started yet
  private done = false;

  push(delta: string): string {
    this.json += delta;
    if (this.done) return "";
    if (this.pos === -1) {
      const key = /"answer"\s*:\s*"/.exec(this.json);
      if (!key) return "";
      this.pos = key.index + key[0].length;
    }
    let out = "";
    while (this.pos < this.json.length) {
      const ch = this.json[this.pos]!;
      if (ch === '"') {
        this.done = true;
        break;
      }
      if (ch !== "\\") {
        out += ch;
        this.pos++;
        continue;
      }
      // An escape: wait until all of it has arrived
      const next = this.json[this.pos + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = this.json.slice(this.pos + 2, this.pos + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
        continue;
      }
      out += ({ n: "\n", t: "\t", r: "", b: "", f: "" } as Record<string, string>)[next] ?? next;
      this.pos += 2;
    }
    return out;
  }
}

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
- Start with the answer itself: the first sentence gives the meaning, value (with unit) or action that was asked, and names the manual in a few words (e.g. "H62 is a water flow error (Panasonic Aquarea service manual)."). No introduction, no remarks about your search, and never list manuals that do NOT contain it.
- Be short and practical: the technician is on site. For a fault code, give its meaning and every check or step in order, including what to replace at the end, as a numbered list. Keep every check complete: how to test it and what to do with each result (e.g. "no continuity: replace the flow switch; continuity: replace the PCB"). Leave out only introductions and remarks. If the sources list causes but not how to test them, search again for that code's troubleshooting procedure or flow chart (in that manual's language) before answering; never tell the technician to find the procedure elsewhere.
- Every fact must come from a source. List the numbers of the sources you used in "sources".
- If several components fit the question (e.g. two 3-way valves next to a buffer tank, or the same setting on different models), do not pick one: give the answer for each, naming the component or model.
- If the question names the equipment (brand, model or unit), answer ONLY from that manual. If that manual does not cover it, abstain: never offer another brand's values instead, even with a warning.
- If the question does not name the equipment and the answer depends on the installation, check the other manuals too (search_manuals) and answer per manual, naming each, but only the manuals that contain an answer; include the installation drawings (P&ID) for questions about plant-room components.
- For a component of an installation (a valve, tank, pump, safety valve, expansion vessel in a plant room), always check the P&ID drawing from the manuals list: if it is not in your sources, search it with its own words and tags (e.g. in Dutch: "veiligheidsklep", "buffervat", "driewegklep") before answering.
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

// Turns a follow-up into a question that can be searched on its own, in the follow-up's language.
// "en op de buitenunit?" after a question about F12 becomes "wat betekent F12 op de buitenunit?".
// One short Haiku call (~$0.0001); a question that is already complete comes back unchanged.
async function standaloneQuestion(
  question: string,
  history: Turn[],
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const earlier = history.map((turn) => `Technician: ${turn.question}\nAnswer: ${turn.answer}`).join("\n\n");
  const response = await client.messages.create({
    model: config.answerModel,
    max_tokens: 300,
    output_config: { effort: "low" },
    system:
      "Rewrite the technician's last question so it can be understood without the conversation: fill in the equipment, " +
      "code or part it refers to. Keep its language and its meaning. If it is already complete, return it unchanged. " +
      "Reply with the question only.",
    messages: [{ role: "user", content: `${earlier}\n\nLast question: ${question}` }],
  });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return {
    text: text === "" ? question : text.slice(0, 2000),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// onEvent is optional. The CLI and the eval leave it out, so they behave exactly as before.
export async function ask(
  tenantId: string,
  question: string,
  onEvent?: (event: AskEvent) => void,
  history: Turn[] = [], // earlier turns of this conversation, oldest first (empty = a new question)
): Promise<AskResult> {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  // 0. A follow-up ("and what about the outdoor unit?") cannot be searched on its own words:
  // Claude first rewrites it into a complete question, using the earlier turns.
  onEvent?.({ type: "searching" });
  let searchQuestion = question;
  if (history.length > 0) {
    const rewritten = await standaloneQuestion(question, history);
    searchQuestion = rewritten.text;
    inputTokens += rewritten.inputTokens;
    outputTokens += rewritten.outputTokens;
  }

  // 1. Retrieve + 2. Augment: the best chunks for the question, numbered so Claude can cite them
  const hits: Hit[] = [];
  const timings: AskResult["timings"] = { searchMs: 0, rerankMs: 0, claudeMs: 0, claudeTurns: 0 };
  const sources = await findSources(tenantId, searchQuestion, hits, timings);
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
  // Earlier turns are context only: the facts of the new answer must still come from the sources
  const earlier =
    history.length === 0
      ? ""
      : `Earlier in this conversation (context only, facts must come from the sources below):\n${history
          .map((turn) => `Technician: ${turn.question}\nYou: ${turn.answer}`)
          .join("\n\n")}\n\n`;
  const asked = searchQuestion === question ? question : `${question}\n(Meaning: ${searchQuestion})`;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Manuals of this company:\n${manuals}\n\n${earlier}${sources}\n\nQuestion: ${asked}` },
  ];
  const searches: string[] = [];

  for (let turn = 0; turn <= MAX_SEARCHES + 2; turn++) {
    onEvent?.({ type: "thinking" });
    const claudeStarted = Date.now();
    // Streamed, so the answer text can be shown while Claude writes it. finalMessage() gives the same
    // checked JSON (parsed_output) as messages.parse would.
    const reader = new AnswerTextReader();
    let streamedAny = false;
    const stream = client.messages.stream({
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
    if (onEvent) {
      stream.on("text", (delta) => {
        const text = reader.push(delta);
        if (text !== "") {
          streamedAny = true;
          onEvent({ type: "answer_delta", text });
        }
      });
    }
    const response = await stream.finalMessage();
    if (streamedAny && response.stop_reason === "tool_use") onEvent?.({ type: "answer_reset" });
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
        onEvent?.({ type: "searching_again", query });
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
      if (!seen) {
        citations.push({ filename: hit.filename, pageStart: hit.pageStart, pageEnd: hit.pageEnd, ...(hit.section ? { section: hit.section } : {}) });
      }
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
