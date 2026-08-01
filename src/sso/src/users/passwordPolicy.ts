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

export function knownDefaultPasswordForUser(user: SsoUserRecord): string | undefined {
  const candidates = [...new Set([config.defaultUserPassword, user.ssoUser].filter((value): value is string => Boolean(value)))];
  return candidates.find((candidate) => verifyPassword(candidate, user.passwordHash, user.salt));
}
