import { config } from '../config.js';
import { verifyPassword } from '../auth/password.js';
import type { SsoUserRecord } from '../db/usersRepo.js';

export function resolveInitialPassword(ssoUser: string, explicitPassword?: string): string {
  if (explicitPassword !== undefined) {
    if (!explicitPassword) throw new Error('Password must not be empty.');
    return explicitPassword;
  }
  return config.defaultUserPassword ?? ssoUser;
}

export async function knownDefaultPasswordForUserAsync(user: SsoUserRecord): Promise<string | undefined> {
  for (const candidate of defaultCandidates(user)) {
    if (await verifyPassword(candidate, user.passwordHash, user.salt)) return candidate;
  }
  return undefined;
}

function defaultCandidates(user: SsoUserRecord): string[] {
  return [...new Set([config.defaultUserPassword, user.ssoUser].filter((value): value is string => Boolean(value)))];
}
