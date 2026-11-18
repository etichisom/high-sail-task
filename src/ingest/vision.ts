// Read one PDF page with Claude vision: icons, diagrams and broken tables become searchable text.
// Each page is read once; the result is cached in store/vision/<pdf sha256>-p<page>.md (like the Docling cache).
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costUsd } from "../answer/ask.js";
import { config } from "../config.js";

const cacheDir = join(config.storeDir, "vision");
const client = new Anthropic();

// Tested in Lab 8.6 on the P&ID (A1 drawing), EcoFlow icon pages and Mitsubishi p5
const PROMPT = `This is one page of a technical manual or drawing.
Transcribe everything on it as markdown, in the page's own language.
- Tables become markdown tables, with their column headers.
- For every icon or pictogram, describe what it looks like in words (e.g. "suitcase with a clock", "yellow warning triangle") followed by the meaning the page gives it.
- For diagrams and P&IDs: list every component with its tag and data (size, pressure, setpoint), then list every pipe connection as "tag → tag" in flow order, including valves on each line.
- Keep codes and tags exactly as printed (e.g. V-202, EV-01, F12).
Output only the transcription.`;

export type PageText = { text: string; costUsd: number | null; cached: boolean };

export async function readPage(pdfPath: string, fileHash: string, page: number): Promise<PageText> {
  const cachePath = join(cacheDir, `${fileHash}-p${page}.md`);
  if (existsSync(cachePath)) return { text: readFileSync(cachePath, "utf8"), costUsd: 0, cached: true };

  const image = renderPage(pdfPath, page);
  const response = await client.messages.create({
    model: config.visionModel,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`page ${page}: vision stopped early (${response.stop_reason})`);

  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, text);
  return { text, costUsd: costUsd(config.visionModel, response.usage.input_tokens, response.usage.output_tokens), cached: false };
}

// PDF page → PNG (base64). 150 dpi reads well; huge drawings get fewer dpi so the image stays
// under the API's 8000-pixel limit (an A1 P&ID at 150 dpi is ~5000 px wide, which is fine).
function renderPage(pdfPath: string, page: number): string {
  const info = execFileSync("pdfinfo", ["-f", String(page), "-l", String(page), pdfPath]).toString();
  const size = info.match(/Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/);
  const longestSide = size ? Math.max(Number(size[1]), Number(size[2])) : 842; // points (1/72 inch)
  const dpi = Math.min(150, Math.floor((7500 / longestSide) * 72));

  const dir = mkdtempSync(join(tmpdir(), "page-")); // a private temp folder, so parallel pages never clash
  try {
    const base = join(dir, "page");
    // stdio "ignore" for errors: pdftoppm prints harmless font warnings for some PDFs
    execFileSync("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(dpi), "-png", "-singlefile", pdfPath, base], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return readFileSync(`${base}.png`).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
