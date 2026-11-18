// Read the flagged pages of ingested PDFs with Claude vision and store them as extra chunks.
// Usage: npm run vision -- --tenant <company name> <pdf> [more pdfs]
// Afterwards run `npm run embed -- --tenant <company name>` to give the new chunks their vectors.
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { addVisionChunks } from "../ingest/vision-chunks.js";
import { findTenant } from "../tenants.js";

const { values, positionals: pdfs } = parseArgs({
  options: { tenant: { type: "string" } },
  allowPositionals: true,
});
if (!values.tenant || pdfs.length === 0) {
  console.error("Usage: npm run vision -- --tenant <company name> <pdf> [more pdfs]");
  process.exit(1);
}
const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}".`);
  process.exit(1);
}

let totalCost = 0;
const started = Date.now();
for (const pdf of pdfs) {
  const pdfStarted = Date.now();
  try {
    const result = await addVisionChunks(tenantId, pdf, (page, cached) =>
      process.stdout.write(cached ? `p${page}(cache) ` : `p${page} `),
    );
    totalCost += result.costUsd;
    const seconds = ((Date.now() - pdfStarted) / 1000).toFixed(0);
    console.log(`\n${pdf}: ${result.added} new vision chunks (${result.pages} flagged pages) · $${result.costUsd.toFixed(4)} · ${seconds}s`);
    for (const failure of result.failed) console.log(`  FAILED ${failure}`);
  } catch (error) {
    console.log(`${pdf}: FAILED - ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\nTotal: $${totalCost.toFixed(4)} in ${((Date.now() - started) / 1000).toFixed(0)}s. Next: npm run embed -- --tenant ${values.tenant}`);

await pool.end();
