// Login sessions. The browser holds only the session id in a cookie; the company is looked up here.
import { config } from "../config.js";
import { pool } from "../db.js";

// Who is logged in, with the company they belong to
export type SessionUser = {
  userId: string;
  tenantId: string;
  email: string;
  company: string;
};

// A session id is a UUID. Checking the shape first means a random or forged cookie never reaches the database.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createSession(userId: string): Promise<string> {
  // Old sessions are removed here, so the table does not grow forever
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO sessions (user_id, expires_at) VALUES ($1, now() + make_interval(secs => $2)) RETURNING id",
    [userId, config.sessionDays * 24 * 60 * 60],
  );
  return rows[0]!.id;
}

export async function findSession(sessionId: string): Promise<SessionUser | null> {
  if (!UUID.test(sessionId)) return null;
  const { rows } = await pool.query<{ user_id: string; tenant_id: string; email: string; company: string }>(
    `SELECT u.id AS user_id, u.tenant_id, u.email, t.name AS company
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN tenants t ON t.id = u.tenant_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  return { userId: row.user_id, tenantId: row.tenant_id, email: row.email, company: row.company };
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!UUID.test(sessionId)) return;
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}
