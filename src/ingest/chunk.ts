// Docling JSON → chunks for the database.
// Rules from Lab 7:
//  1. drop page headers/footers ("furniture")
//  2. drop duplicate text on the same page (some PDFs have a hidden second text layer)
//  3. one chunk per section; a long section is split at paragraph boundaries.
//     Docling gives every heading level 1, so we rebuild two levels ourselves:
//     a numbered heading ("3.26 F12 - ...") is the main section, an unnumbered one
//     ("Oorzaken van de fout:") is a sub-section under it → "3.26 F12 - ... > Oorzaken van de fout:"
//  4. a table is its own chunk; a long table is split by rows, repeating the header row
//  5. text found inside a picture (diagram labels, flowchart steps) becomes a "figure" chunk
//  6. every chunk keeps its PDF page range for citations
import type { DoclingDoc, Item, TableItem, TextItem } from "./docling-types.js";

export type Chunk = {
  chunkType: "text" | "table" | "figure";
  section: string | null;
  pageStart: number;
  pageEnd: number;
  content: string;
};

const MAX_CHARS = 2000; // about 500 tokens
const MIN_FIGURE_CHARS = 40; // skip pictures whose OCR text is only icon junk like "日" or "°C"
const NUMBERED_HEADING = /^\d+(\.\d+)*\.?\s*\S/; // "3.26 F12 ...", "11.8 Error codes", "2. STORINGSANALYSE"

// One piece of the document, in reading order
type Block =
  | { kind: "text"; label: string; text: string; page: number }
  | { kind: "table"; rows: string[][]; caption: string; page: number }
  | { kind: "figure"; lines: string[]; page: number };

export function chunkDocument(doc: DoclingDoc): Chunk[] {
  const blocks = dedupe(readingOrder(doc));
  const chunks: Chunk[] = [];
  const repeated = repeatedHeadings(blocks);

  let main: string | null = null; // e.g. "3.26 F12 - inschakelen van de hogedrukschakelaar ..."
  let mainIsNumbered = false;
  let sub: string | null = null; // e.g. "Oorzaken van de fout:"
  let section: string | null = null;
  let lines: string[] = [];
  let pages: number[] = [];

  // Close the text chunk we are building (if any)
  const flush = () => {
    if (lines.length > 0) {
      chunks.push(makeChunk("text", section, pages, lines.join("\n")));
    }
    lines = [];
    pages = [];
  };

  for (const block of blocks) {
    if (block.kind === "text" && block.label === "section_header" && !repeated.has(block.text)) {
      flush();
      if (NUMBERED_HEADING.test(block.text) || !mainIsNumbered) {
        main = block.text;
        mainIsNumbered = NUMBERED_HEADING.test(block.text);
        sub = null;
      } else {
        sub = block.text;
      }
      section = sub ? `${main} > ${sub}` : main;
    } else if (block.kind === "text") {
      const line = block.label === "list_item" ? `- ${block.text}` : block.text;
      if (currentLength(lines) + line.length > MAX_CHARS) flush();
      lines.push(line);
      pages.push(block.page);
    } else if (block.kind === "table") {
      flush();
      for (const part of splitTable(block.rows)) {
        const caption = block.caption ? `${block.caption}\n` : "";
        chunks.push(makeChunk("table", section, [block.page], caption + toMarkdown(part)));
      }
    } else if (block.kind === "figure") {
      const text = block.lines.join("\n");
      if (text.length >= MIN_FIGURE_CHARS) {
        chunks.push(makeChunk("figure", section, [block.page], text));
      }
    }
  }
  flush();
  return chunks;
}

// The section title goes at the top of the content, so search also sees which section a chunk belongs to
function makeChunk(chunkType: Chunk["chunkType"], section: string | null, pages: number[], body: string): Chunk {
  return {
    chunkType,
    section,
    pageStart: Math.min(...pages),
    pageEnd: Math.max(...pages),
    content: section ? `${section}\n\n${body}` : body,
  };
}

// Headings that appear 3+ times are labels inside sections, not new sections:
// "Oorzaken van de fout:" appears under every error code, "WARNING" all over a manual.
// They stay in the chunk as a normal line, so F12's causes stay together with "F12".
function repeatedHeadings(blocks: Block[]): Set<string> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.kind === "text" && block.label === "section_header") {
      counts.set(block.text, (counts.get(block.text) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count >= 3).map(([text]) => text));
}

function currentLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

// --- Reading order --------------------------------------------------------

// Walk the document tree from "body" in reading order and turn it into blocks
function readingOrder(doc: DoclingDoc): Block[] {
  const blocks: Block[] = [];

  const visit = (item: Item) => {
    if (item.content_layer === "furniture") return; // rule 1
    const page = item.prov?.[0]?.page_no;

    if (item.self_ref.startsWith("#/tables/") && page) {
      const table = item as TableItem;
      const caption = childTexts(doc, item).join(" ");
      blocks.push({ kind: "table", rows: table.data.grid.map((row) => row.map((cell) => clean(cell.text))), caption, page });
    } else if (item.self_ref.startsWith("#/pictures/") && page) {
      blocks.push({ kind: "figure", lines: childTexts(doc, item), page });
    } else if (item.self_ref.startsWith("#/texts/") && page) {
      const text = clean((item as TextItem).text);
      if (text) blocks.push({ kind: "text", label: item.label, text, page });
      for (const child of children(doc, item)) visit(child);
    } else {
      for (const child of children(doc, item)) visit(child); // groups (lists etc.) and body
    }
  };

  visit(doc.body);
  return blocks;
}

// All text inside an item (a picture's OCR labels, a table's caption), including nested groups
function childTexts(doc: DoclingDoc, item: Item): string[] {
  const out: string[] = [];
  for (const child of children(doc, item)) {
    if (child.self_ref.startsWith("#/texts/")) {
      const text = clean((child as TextItem).text);
      if (text) out.push(text);
    }
    out.push(...childTexts(doc, child));
  }
  return out;
}

// Turn the "$ref" pointers of an item into the items they point to
function children(doc: DoclingDoc, item: Item): Item[] {
  return (item.children ?? []).flatMap((ref) => {
    const [, collection, index] = ref.$ref.split("/"); // "#/texts/12" → ["#", "texts", "12"]
    const list = (doc as unknown as Record<string, Item[]>)[collection ?? ""];
    const found = list?.[Number(index)];
    return found ? [found] : [];
  });
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- Duplicates (rule 2) --------------------------------------------------

function dedupe(blocks: Block[]): Block[] {
  const seen = new Set<string>();
  const key = (page: number, text: string) => `${page}|${text}`;

  // Text in the normal flow wins over the same text repeated inside a picture
  for (const block of blocks) {
    if (block.kind === "text") seen.add(key(block.page, block.text));
  }

  const out: Block[] = [];
  const kept = new Set<string>();
  for (const block of blocks) {
    if (block.kind === "text") {
      const k = key(block.page, block.text);
      if (kept.has(k)) continue;
      kept.add(k);
      out.push(block);
    } else if (block.kind === "figure") {
      const lines = block.lines.filter((line) => !seen.has(key(block.page, line)));
      out.push({ ...block, lines });
    } else {
      out.push(block);
    }
  }
  return out;
}

// --- Tables (rule 4) ------------------------------------------------------

// Split a long table into parts that each fit in MAX_CHARS. Every part repeats the header row.
function splitTable(rows: string[][]): string[][][] {
  const [header, ...body] = rows;
  if (!header) return [];
  const parts: string[][][] = [];
  let part: string[][] = [];
  for (const row of body) {
    if (part.length > 0 && toMarkdown([header, ...part, row]).length > MAX_CHARS) {
      parts.push([header, ...part]);
      part = [];
    }
    part.push(row);
  }
  parts.push([header, ...part]);
  return parts;
}

function toMarkdown(rows: string[][]): string {
  const line = (row: string[]) => `| ${row.join(" | ")} |`;
  const [header, ...body] = rows;
  if (!header) return "";
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  return [line(header), separator, ...body.map(line)].join("\n");
}