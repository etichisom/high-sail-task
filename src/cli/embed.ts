// Embed all chunks of one company that have no vector yet.
// Usage: npm run embed -- --tenant <company name>
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { embedChunks } from "../ingest/embed-chunks.js";
import { findTenant } from "../tenants.js";

const { values } = parseArgs({ options: { tenant: { type: "string" } } });
if (!values.tenant) {
  console.error("Usage: npm run embed -- --tenant <company name>");
  process.exit(1);
}

const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}". Run ingest first.`);
  process.exit(1);
}

const started = Date.now();
const count = await embedChunks(tenantId, (done) => console.log(`  ${done} chunks embedded…`));
const seconds = (Date.now() - started) / 1000;

if (count === 0) {
  console.log(`tenant "${values.tenant}": all chunks already have an embedding`);
} else {
  // The time includes loading the model (a few seconds), so small runs look slower per chunk
  console.log(
    `tenant "${values.tenant}": ${count} chunks embedded in ${seconds.toFixed(1)}s (${(count / seconds).toFixed(1)} chunks/s)`,
  );
}

await pool.end();
