// Show which pages of a PDF will also go to Haiku vision, and why.
// Usage: npm run vision-pages -- <pdf>
import { convertPdf } from "../ingest/docling.js";
import { pagesNeedingVision } from "../ingest/needs-vision.js";

const pdf = process.argv[2];
if (!pdf) {
  console.error("Usage: npm run vision-pages -- <pdf>");
  process.exit(1);
}

const doc = await convertPdf(pdf);
const pages = pagesNeedingVision(doc);
console.log(`${pages.length} of ${Object.keys(doc.pages).length} pages need vision`);
for (const { page, reasons } of pages) {
  console.log(`  p${page}: ${reasons.join(", ")}`);
}