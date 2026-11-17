// Ask a question from the terminal.
// Usage: npm run ask -- --tenant <company name> "your question"
import { parseArgs } from "node:util";
import { ask } from "../answer/ask.js";
import { pool } from "../db.js";
import { findTenant } from "../tenants.js";

const { values, positionals } = parseArgs({
  options: { tenant: { type: "string" } },
  allowPositionals: true,
});
const question = positionals.join(" ");
if (!values.tenant || !question) {
  console.error('Usage: npm run ask -- --tenant <company name> "your question"');
  process.exit(1);
}

const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}".`);
  process.exit(1);
}

const result = await ask(tenantId, question);

console.log(`Q: ${question}\n`);
console.log(result.answer);
console.log();
if (result.abstained) {
  console.log("(not in the manuals)");
} else {
  for (const c of result.citations) {
    const pages = c.pageStart === c.pageEnd ? `page ${c.pageStart}` : `pages ${c.pageStart}-${c.pageEnd}`;
    console.log(`  source: ${c.filename}, ${pages}`);
  }
}
const cost = result.costUsd === null ? "unknown" : `$${result.costUsd.toFixed(5)}`;
console.log(
  `\n${result.latencyMs} ms (search ${result.searchMs} ms) · ${result.inputTokens} in + ${result.outputTokens} out tokens · ${cost}`,
);

await pool.end();