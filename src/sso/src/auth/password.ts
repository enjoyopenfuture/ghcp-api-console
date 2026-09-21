import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password: string): { passwordHash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  return { passwordHash: scryptSync(password, salt, KEYLEN).toString('hex'), salt };
}

export function verifyPassword(password: string, passwordHash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(passwordHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function verifyPasswordAsync(password: string, passwordHash: string, salt: string): Promise<boolean> {
  const candidate = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEYLEN, (error, result) => error ? reject(error) : resolve(result));
  });
  const expected = Buffer.from(passwordHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
