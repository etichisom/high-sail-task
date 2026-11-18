// Password hashing with scrypt, built into Node (no extra package).
// Stored form: scrypt$<salt hex>$<hash hex>. The salt is random per password, so two users with the
// same password get different stored values.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const KEY_BYTES = 64;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;

  const key = await deriveKey(password, salt);
  // timingSafeEqual takes the same time whatever the bytes are, so the check does not leak the hash
  return timingSafeEqual(key, expected);
}
