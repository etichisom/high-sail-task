// Lab 4: can Claude read a page image?
// Usage: npx tsx src/test-claude.ts <pdf-file> <page-number>
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const pdf = process.argv[2] ?? "data/docs/mitsubishi-ecodan-hydrobox-operation-en.pdf";
const page = Number(process.argv[3] ?? 5);

// 1. Turn one PDF page into a PNG image (150 dpi is readable but not huge)
mkdirSync("store/tmp", { recursive: true });
const outBase = "store/tmp/page";
execFileSync("pdftoppm", ["-f", String(page), "-l", String(page), "-r", "150", "-png", "-singlefile", pdf, outBase]);
const imageB64 = readFileSync(`${outBase}.png`).toString("base64");

// 2. Ask Claude to transcribe it
const client = new Anthropic();
const started = Date.now();
const response = await client.beta.messages.create({
  model: "claude-haiku-5-5",
  max_tokens: 16000,
  output_config: { effort: "medium" },
  messages: [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } },
        {
          type: "text",
          text:
            "This is one page of a technical manual. Transcribe everything on it as markdown, in the page's own language. " +
            "Tables become markdown tables. For every icon or pictogram, describe what it looks like in words " +
            "(e.g. 'suitcase with a clock') followed by the meaning the page gives it. " +
            "For diagrams, list every labelled component, tag and connection.",
        },
      ],
    },
  ],
});
const latencyMs = Date.now() - started;

// 3. Print the result + what it cost
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}
const u = response.usage;
const cost = (u.input_tokens * 0.1 + u.output_tokens * 0.5) / 1_000_000; // Haiku 5.5: $0.10 in / $0.50 out per 1M tokens
console.log("\n---");
console.log(`stop_reason=${response.stop_reason} latency=${(latencyMs / 1000).toFixed(1)}s`);
console.log(`tokens in=${u.input_tokens} out=${u.output_tokens} cost=$${cost.toFixed(4)}`);
