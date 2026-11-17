// Convert PDFs with Docling and fill the cache.
// Usage: npm run convert -- <pdf> [more pdfs]
import { convertPdf } from "../ingest/docling.js";

const pdfs = process.argv.slice(2);
if (pdfs.length === 0) {
  console.error("Usage: npm run convert -- <pdf> [more pdfs]");
  process.exit(1);
}

for (const pdf of pdfs) {
  const started = Date.now();
  const doc = await convertPdf(pdf);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const pages = Object.keys(doc.pages ?? {}).length;
  console.log(`${pdf}: ${pages} pages, ${doc.texts?.length} texts, ${doc.tables?.length} tables (${seconds}s)`);
}