// PDF → Docling JSON. Each unique file is converted once; the result is cached in store/docling/<sha256>.json
import { DoclingClient } from "@docling/docling-client";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { DoclingDoc } from "./docling-types.js";

const client = new DoclingClient({
  baseUrl: config.doclingUrl,
  jobTimeoutMs: 20 * 60_000, // scanned PDFs take minutes on a laptop CPU
});

const cacheDir = join(config.storeDir, "docling");

// The file's fingerprint: same bytes → same hash, whatever the filename
export function fileHash(pdfPath: string): string {
  return createHash("sha256").update(readFileSync(pdfPath)).digest("hex");
}

export async function convertPdf(pdfPath: string): Promise<DoclingDoc> {
  const cachePath = join(cacheDir, `${fileHash(pdfPath)}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  }

  // Big PDFs are converted in parts: Docling holds every page of a job in memory, and with 8 GB
  // for Docker the 180-page De Dietrich manual crashed it (Lab 14). Docling keeps the real page numbers.
  const pages = pageCount(pdfPath);
  const size = config.doclingPagesPerPart;
  const parts: DoclingDoc[] = [];
  for (let start = 1; start <= pages; start += size) {
    const pageRange: [number, number] | undefined = pages > size ? [start, Math.min(pages, start + size - 1)] : undefined;
    const result = await client.convert(pdfPath, {
      options: { do_ocr: true, ...(pageRange ? { page_range: pageRange } : {}) },
      raisesOnError: true,
    });
    parts.push(result.document as DoclingDoc);
  }
  const doc = parts.length === 1 ? parts[0]! : mergeParts(parts);

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(doc));
  return doc;
}

function pageCount(pdfPath: string): number {
  const info = execFileSync("pdfinfo", [pdfPath], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  return Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
}

// Glue the parts into one document. Items point to each other by position ("#/texts/12"), so every
// pointer in a later part is shifted by the number of items that came before it.
function mergeParts(parts: DoclingDoc[]): DoclingDoc {
  const first = parts[0]!;
  const merged: DoclingDoc = {
    ...first,
    body: { ...first.body, children: [] },
    texts: [],
    tables: [],
    pictures: [],
    groups: [],
    pages: {},
  };
  for (const part of parts) {
    const offset = {
      texts: merged.texts.length,
      tables: merged.tables.length,
      pictures: merged.pictures.length,
      groups: merged.groups.length,
    };
    const shifted: DoclingDoc = JSON.parse(
      JSON.stringify(part).replace(
        /"#\/(texts|tables|pictures|groups)\/(\d+)"/g,
        (_, list: keyof typeof offset, index: string) => `"#/${list}/${Number(index) + offset[list]}"`,
      ),
    );
    merged.texts.push(...shifted.texts);
    merged.tables.push(...shifted.tables);
    merged.pictures.push(...shifted.pictures);
    merged.groups.push(...shifted.groups);
    merged.body.children!.push(...(shifted.body.children ?? []));
    Object.assign(merged.pages, shifted.pages);
  }
  return merged;
}
