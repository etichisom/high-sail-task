// Which pages should ALSO be read by Haiku vision? (routing rules from Lab 7)
// Docling's chunks are always kept; a flagged page gets an extra vision chunk.
// The rules are generous on purpose: a wrongly flagged page costs ~$0.002, a missed icon page costs a wrong answer.
import type { DoclingDoc, Item, TableItem } from "./docling-types.js";

export type VisionPage = { page: number; reasons: string[] };

const LARGE_PAGE = 1200; // points; A4 is 595×842, so this catches A3/A1 drawings like the P&ID
const PICTURE_COVERAGE = 0.3; // pictures cover more than 30% of the page → diagram, flowchart
const SMALL_PICTURE = 0.03; // pictures under 3% of the page (logos) don't count
const TINY_TEXTS = 25; // 25+ text bits of 1–4 characters → icon labels, diagram tags
const JUNK = /[\u2E80-\u9FFF]/; // Chinese-looking characters in a European manual = icons misread by OCR

export function pagesNeedingVision(doc: DoclingDoc, extraPages: number[] = []): VisionPage[] {
  const result: VisionPage[] = [];

  for (const { page_no: page, size } of Object.values(doc.pages)) {
    const reasons: string[] = [];
    const pageArea = size.width * size.height;
    const texts = doc.texts.filter((t) => pageOf(t) === page).map((t) => t.text.trim());

    if (Math.max(size.width, size.height) > LARGE_PAGE) {
      reasons.push(`large page ${Math.round(size.width)}×${Math.round(size.height)}`);
    }

    const coverage = doc.pictures
      .filter((p) => pageOf(p) === page)
      .map((p) => area(p) / pageArea)
      .filter((share) => share >= SMALL_PICTURE)
      .reduce((sum, share) => sum + share, 0);
    if (coverage > PICTURE_COVERAGE) reasons.push(`pictures cover ${Math.round(coverage * 100)}%`);

    const tiny = texts.filter((t) => t.length > 0 && t.length <= 4).length;
    if (tiny >= TINY_TEXTS) reasons.push(`${tiny} tiny text bits`);

    if (texts.some((t) => JUNK.test(t))) reasons.push("icons read as junk characters");

    if (doc.tables.some((t) => pageOf(t) === page && hasEmptyColumn(t))) {
      reasons.push("table with an empty column");
    }

    // 'click " " to reset': empty quotes in the text are where an inline icon was (EcoFlow p7)
    if (texts.some((t) => /["“”]\s*["”“]/.test(t))) reasons.push("icon inside the text");

    if (doc.tables.some((t) => pageOf(t) === page && hasRepeatedHeader(t))) {
      reasons.push("table lost its column names");
    }

    if (extraPages.includes(page)) reasons.push("listed by hand");

    if (reasons.length > 0) result.push({ page, reasons });
  }
  return result.sort((a, b) => a.page - b.page);
}

function pageOf(item: Item): number | undefined {
  return item.prov?.[0]?.page_no;
}

function area(item: Item): number {
  const box = item.prov?.[0]?.bbox;
  return box ? Math.abs(box.r - box.l) * Math.abs(box.t - box.b) : 0;
}

// A column that is empty in most rows usually held icons that OCR could not read (Mitsubishi p5)
function hasEmptyColumn(table: TableItem): boolean {
  const [, ...rows] = table.data.grid; // skip the header row
  if (rows.length < 3) return false;
  const columns = table.data.num_cols;
  for (let col = 0; col < columns; col++) {
    const empty = rows.filter((row) => !row[col]?.text.trim()).length;
    if (empty / rows.length >= 0.8) return true;
  }
  return false;
}

// "Refrigerant | Refrigerant | Refrigerant": the real column names (model sizes) were lost (Midea p81)
function hasRepeatedHeader(table: TableItem): boolean {
  const header = table.data.grid[0]?.map((cell) => cell.text.trim()) ?? [];
  const names = header.slice(1).filter((name) => name !== "");
  return header.length >= 3 && names.length >= 2 && new Set(names).size === 1;
}
