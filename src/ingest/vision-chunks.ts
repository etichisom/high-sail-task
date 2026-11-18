// Add a vision chunk for every flagged page of one ingested PDF (Docling's chunks stay as they are).
// Pages that already have a vision chunk are skipped, so running it again only does new work.
import { basename } from "node:path";
import { pool } from "../db.js";
import { config } from "../config.js";
import { convertPdf, fileHash } from "./docling.js";
import { pagesNeedingVision } from "./needs-vision.js";
import { readPage } from "./vision.js";

export type VisionResult = { pages: number; added: number; costUsd: number; failed: string[] };

export async function addVisionChunks(
  tenantId: string,
  pdfPath: string,
  onPage?: (page: number, cached: boolean) => void, // lets the CLI show progress
): Promise<VisionResult> {
  const hash = fileHash(pdfPath);
  const found = await pool.query<{ id: string }>(
    // No status check: the pipeline calls this while the document is still 'processing' (before it is ready)
    "SELECT id FROM documents WHERE tenant_id = $1 AND file_hash = $2",
    [tenantId, hash],
  );
  const documentId = found.rows[0]?.id;
  if (!documentId) throw new Error("not ingested for this company yet (run ingest first)");

  const flagged = pagesNeedingVision(await convertPdf(pdfPath)).map((p) => p.page);
  const done = await pool.query<{ page_start: number }>(
    "SELECT page_start FROM chunks WHERE tenant_id = $1 AND document_id = $2 AND source = 'vision'",
    [tenantId, documentId],
  );
  const alreadyDone = new Set(done.rows.map((row) => row.page_start));
  const todo = flagged.filter((page) => !alreadyDone.has(page));

  const result: VisionResult = { pages: flagged.length, added: 0, costUsd: 0, failed: [] };

  // A few pages at the same time: each call waits ~10 s for Claude, so 4 in parallel is ~4× faster
  const queue = [...todo];
  async function worker() {
    for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
      try {
        const { text, costUsd, cached } = await readPage(pdfPath, hash, page);
        // One transaction per page: all its pieces are stored, or none (then the next run retries the page)
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const piece of splitPage(text, basename(pdfPath, ".pdf"))) {
            await client.query(
              `INSERT INTO chunks (tenant_id, document_id, page_start, page_end, chunk_type, section, source, content)
               VALUES ($1, $2, $3, $3, $4, $5, 'vision', $6)`,
              [tenantId, documentId, page, piece.chunkType, piece.section, piece.content],
            );
            result.added++;
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        result.costUsd += costUsd ?? 0;
        onPage?.(page, cached);
      } catch (error) {
        // One bad page must not stop the rest; the next run retries it
        result.failed.push(`p${page}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: config.visionConcurrency }, worker));
  return result;
}

// ---------- Split one page transcription into small, focused chunks ----------
// One vector for a whole page (the P&ID is 5,000+ characters about 30 components) matches no single
// question well. Small pieces under their heading do: "TV-201 → V-202 → BT-01".

const MAX_CHARS = 800;

export type VisionPiece = { chunkType: "text" | "table"; section: string | null; content: string };

// `manual` (e.g. "midea-r290-mono-4-16kw-installation-en") starts every piece: a small table row never
// says which brand it belongs to, so a question naming the brand could not match it otherwise
export function splitPage(markdown: string, manual: string): VisionPiece[] {
  const pieces: VisionPiece[] = [];
  let title: string | null = null; // the page's "# " heading
  let heading: string | null = null; // the current "## " (or deeper) heading
  let paragraphs: string[] = [];
  let table: string[] = [];
  let paragraph: string[] = [];

  const section = () => [title, heading].filter(Boolean).join(" > ") || null;
  // Each piece starts with its heading, so a piece still makes sense on its own
  const withContext = (body: string) => [manual, section(), body].filter(Boolean).join("\n\n");

  function flushText() {
    let current = "";
    for (const text of paragraphs) {
      if (current && current.length + text.length > MAX_CHARS) {
        pieces.push({ chunkType: "text", section: section(), content: withContext(current) });
        current = "";
      }
      current = current ? `${current}\n\n${text}` : text;
    }
    if (current) pieces.push({ chunkType: "text", section: section(), content: withContext(current) });
    paragraphs = [];
  }

  // Long tables are split between rows, and every part repeats the header row (like the Docling chunker)
  function flushTable() {
    const [header = "", divider = "", ...rows] = table;
    let current: string[] = [];
    const push = () => {
      if (current.length > 0) {
        pieces.push({ chunkType: "table", section: section(), content: withContext([header, divider, ...current].join("\n")) });
      }
      current = [];
    };
    for (const row of rows) {
      if (current.length > 0 && [header, ...current, row].join("\n").length > MAX_CHARS) push();
      current.push(row);
    }
    push();
    table = [];
  }

  function endParagraph() {
    if (paragraph.length > 0) paragraphs.push(paragraph.join("\n"));
    paragraph = [];
  }

  for (const line of markdown.split("\n")) {
    const isTableRow = line.trim().startsWith("|");
    if (!isTableRow && table.length > 0) flushTable();

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      endParagraph();
      flushText();
      if (headingMatch[1] === "#" && title === null) title = headingMatch[2]!.trim();
      else heading = headingMatch[2]!.trim();
    } else if (isTableRow) {
      endParagraph();
      flushText(); // text before a table becomes its own piece
      table.push(line);
    } else if (line.trim() === "") {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  if (table.length > 0) flushTable();
  endParagraph();
  flushText();
  return pieces;
}
