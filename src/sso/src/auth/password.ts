import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

// scrypt runs on the libuv thread pool; the sync variant would block the event loop (and /healthz) for every hash.
export async function hashPassword(password: string): Promise<{ passwordHash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  return { passwordHash: (await deriveKey(password, salt)).toString('hex'), salt };
}

export async function verifyPassword(password: string, passwordHash: string, salt: string): Promise<boolean> {
  const candidate = await deriveKey(password, salt);
  const expected = Buffer.from(passwordHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, (error, result) => error ? reject(error) : resolve(result));
  });
}
