// PDF → Docling JSON. Each unique file is converted once; the result is cached in store/docling/<sha256>.json
import { DoclingClient } from "@docling/docling-client";
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

  const result = await client.convert(pdfPath, {
    options: { do_ocr: true },
    raisesOnError: true,
  });

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(result.document));
  return result.document as DoclingDoc;
}