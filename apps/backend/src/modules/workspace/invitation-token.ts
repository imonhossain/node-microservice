import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashToken(raw: string): Promise<string> {
  return argon2.hash(raw, { type: argon2.argon2id });
}

export async function verifyToken(hash: string, raw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, raw);
  } catch {
    return false;
  }
}
