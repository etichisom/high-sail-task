// All settings in one place, read from .env once.
// Other files import `config` and never touch process.env directly.
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  doclingUrl: process.env.DOCLING_URL ?? "http://localhost:5001",
  storeDir: process.env.STORE_DIR ?? "store",
};