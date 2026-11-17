// Companies. The CLI finds a company by name; the web app will create one at sign-up.
import { pool } from "./db.js";

export async function findOrCreateTenant(name: string): Promise<string> {
  const found = await pool.query<{ id: string }>("SELECT id FROM tenants WHERE name = $1", [name]);
  if (found.rows[0]) return found.rows[0].id;

  const created = await pool.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name]);
  return created.rows[0]!.id;
}