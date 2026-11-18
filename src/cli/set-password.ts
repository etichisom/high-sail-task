// Set a new password for an existing login, and log that user out everywhere (their old sessions are deleted).
// Usage: npm run set-password -- --email <email> --password <at least 8 characters>
import { parseArgs } from "node:util";
import { hashPassword } from "../auth/passwords.js";
import { pool } from "../db.js";

const { values } = parseArgs({ options: { email: { type: "string" }, password: { type: "string" } } });
const email = values.email?.trim().toLowerCase() ?? "";
const password = values.password ?? "";
if (!email.includes("@") || password.length < 8) {
  console.error("Usage: npm run set-password -- --email <email> --password <at least 8 characters>");
  process.exit(1);
}

const { rows } = await pool.query<{ id: string }>("UPDATE users SET password_hash = $2 WHERE email = $1 RETURNING id", [
  email,
  await hashPassword(password),
]);
if (rows.length === 0) {
  console.error(`No login with the email ${email}.`);
  process.exitCode = 1;
} else {
  await pool.query("DELETE FROM sessions WHERE user_id = $1", [rows[0]!.id]);
  console.log(`New password set for ${email}; old sessions logged out.`);
}
await pool.end();
