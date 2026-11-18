// Give an existing company (e.g. "demo", made with the CLI) a login, so it can use the API and web app.
// Usage: npm run add-user -- --tenant <company name> --email <email> --password <password>
// Sign-up in the web app creates a new company; this command is for companies that already exist.
import { parseArgs } from "node:util";
import { hashPassword } from "../auth/passwords.js";
import { pool } from "../db.js";
import { findTenant } from "../tenants.js";

const { values } = parseArgs({
  options: { tenant: { type: "string" }, email: { type: "string" }, password: { type: "string" } },
});
const email = values.email?.trim().toLowerCase() ?? "";
const password = values.password ?? "";
if (!values.tenant || !email.includes("@") || password.length < 8) {
  console.error("Usage: npm run add-user -- --tenant <company name> --email <email> --password <at least 8 characters>");
  process.exit(1);
}

const tenantId = await findTenant(values.tenant);
if (!tenantId) {
  console.error(`No company called "${values.tenant}".`);
  process.exit(1);
}

try {
  await pool.query("INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3)", [
    tenantId,
    email,
    await hashPassword(password),
  ]);
  console.log(`${email} can now log in to "${values.tenant}".`);
} catch (error) {
  // 23505 = unique violation: an email belongs to one user (and so to one company) only
  if ((error as { code?: string }).code === "23505") console.error(`${email} is already registered.`);
  else throw error;
  process.exitCode = 1;
}

await pool.end();
