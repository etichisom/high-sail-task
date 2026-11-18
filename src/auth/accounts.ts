// Sign-up and log-in. Sign-up creates a company and its first user together, so there is never a
// company without a user.
import { pool } from "../db.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import type { SessionUser } from "./sessions.js";

// A problem the caller can show to the user, with the HTTP status to send back
export class AccountError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Simple check only: something@something.something, no spaces. Real proof of an address needs an email message.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUp(company: string, email: string, password: string): Promise<SessionUser> {
  const name = company.trim();
  const mail = email.trim().toLowerCase();
  if (name.length < 2 || name.length > 100) throw new AccountError(400, "company name must be 2 to 100 characters");
  if (mail.length > 254 || !EMAIL_PATTERN.test(mail)) throw new AccountError(400, "send a valid email address");
  if (password.length < 8) throw new AccountError(400, "password must be at least 8 characters");

  // Hashing takes a moment on purpose, so it runs before the database transaction starts
  const hash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Two sign-ups for the same company name at the same moment: the second waits here for the first to finish.
    // Without this, both could pass the check below and create two companies with the same name.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name.toLowerCase()]);

    // Companies cannot be joined by name: a taken name is refused, so nobody gets into someone else's company
    const taken = await client.query("SELECT 1 FROM tenants WHERE lower(name) = lower($1)", [name]);
    if (taken.rows.length > 0) throw new AccountError(409, "company already exists");

    const tenant = await client.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name]);
    const tenantId = tenant.rows[0]!.id;
    const user = await client.query<{ id: string }>(
      "INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [tenantId, mail, hash],
    );
    await client.query("COMMIT");
    return { userId: user.rows[0]!.id, tenantId, email: mail, company: name };
  } catch (error) {
    await client.query("ROLLBACK");
    // 23505 = unique violation: the email is already in the users table (the email column is UNIQUE)
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw new AccountError(409, "email already registered");
    }
    throw error;
  } finally {
    client.release();
  }
}

// Returns the user when the email and password match, otherwise null. The caller sends one generic error
// for both cases, so the reply never shows whether an email exists.
export async function logIn(email: string, password: string): Promise<SessionUser | null> {
  const mail = email.trim().toLowerCase();
  const { rows } = await pool.query<{ user_id: string; tenant_id: string; company: string; password_hash: string }>(
    `SELECT u.id AS user_id, u.tenant_id, t.name AS company, u.password_hash
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [mail],
  );
  const row = rows[0];
  if (!row) {
    // Unknown email: do the same slow hash work anyway, so a faster reply does not reveal the email
    await hashPassword(password);
    return null;
  }
  const matches = await verifyPassword(password, row.password_hash);
  if (!matches) return null;
  return { userId: row.user_id, tenantId: row.tenant_id, email: mail, company: row.company };
}
