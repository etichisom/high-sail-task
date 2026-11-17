// Show how a PDF is chunked. Usage: npm run chunks -- <pdf> [search text]
import { convertPdf } from "../ingest/docling.js";
import { chunkDocument } from "../ingest/chunk.js";

const [pdf, search] = process.argv.slice(2);
if (!pdf) {
  console.error("Usage: npm run chunks -- <pdf> [search text]");
  process.exit(1);
}

const chunks = chunkDocument(await convertPdf(pdf));
const count = (type: string) => chunks.filter((c) => c.chunkType === type).length;
console.log(`${chunks.length} chunks: ${count("text")} text, ${count("table")} table, ${count("figure")} figure`);

for (const chunk of chunks.filter((c) => !search || c.content.includes(search)).slice(0, 3)) {
  console.log(`\n--- ${chunk.chunkType}, pages ${chunk.pageStart}-${chunk.pageEnd}, section: ${chunk.section}`);
  console.log(chunk.content.slice(0, 800));
}