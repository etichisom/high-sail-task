// Ingest PDFs for one company.
// Usage: npm run ingest -- --tenant <company name> <pdf> [more pdfs]
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { ingestDocument } from "../ingest/index.js";
import { findOrCreateTenant } from "../tenants.js";

const { values, positionals: pdfs } = parseArgs({
  options: { tenant: { type: "string" } },
  allowPositionals: true,
});
if (!values.tenant || pdfs.length === 0) {
  console.error("Usage: npm run ingest -- --tenant <company name> <pdf> [more pdfs]");
  process.exit(1);
}

const tenantId = await findOrCreateTenant(values.tenant);
console.log(`tenant "${values.tenant}" = ${tenantId}`);

for (const pdf of pdfs) {
  const started = Date.now();
  try {
    const result = await ingestDocument(tenantId, pdf);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status === "skipped") {
      console.log(`${pdf}: already ingested, skipped`);
    } else {
      console.log(
        `${pdf}: ${result.pages} pages → ${result.chunks} chunks, ${result.visionPages.length} pages need vision (${seconds}s)`,
      );
    }
  } catch (error) {
    console.error(`${pdf}: FAILED - ${error instanceof Error ? error.message : String(error)}`);
  }
}

await pool.end(); // close the database connections so the program can exit