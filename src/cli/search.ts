// Try meaning-based search from the terminal.
// Usage: npm run search -- --tenant <company name> "your question"
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { vectorSearch } from "../retrieval/vector-search.js";
import { findTenant } from "../tenants.js";

const { values, positionals } = parseArgs({
  options: { tenant: { type: "string" } },
  allowPositionals: true,
});
const query = positionals.join(" ");
if (!values.tenant || !query) {
  console.error('Usage: npm run search -- --tenant <company name> "your question"');
  process.exit(1);
}

const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}".`);
  process.exit(1);
}

const hits = await vectorSearch(tenantId, query, 5);
console.log(`"${query}"\n`);
for (const [i, hit] of hits.entries()) {
  const pages = hit.pageStart === hit.pageEnd ? `p${hit.pageStart}` : `p${hit.pageStart}-${hit.pageEnd}`;
  // One line per hit: newlines inside the chunk would break the layout
  const preview = hit.content.replace(/\s+/g, " ").slice(0, 80);
  console.log(`${i + 1}. ${hit.distance.toFixed(3)}  ${pages.padEnd(6)} ${hit.chunkType.padEnd(6)} ${preview}`);
}
if (hits.length === 0) console.log("No chunks with embeddings yet. Run: npm run embed -- --tenant " + values.tenant);

await pool.end();
