import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const KEYLEN = 64;

export interface AdminRecord {
  username: string;
  password_hash: string;
  salt: string;
  role: 'admin';
  enabled: boolean;
}

export function isInitialized(): boolean {
  return readAdmins().some((admin) => admin.enabled);
}

export function setupAdmin(username: string, password: string): AdminRecord {
  if (isInitialized()) throw new Error('Console is already initialized.');
  if (!username.trim() || !password) throw new Error('username and password are required.');
  const admin = makeAdmin(username.trim(), password);
  writeAdmins([admin]);
  return admin;
}

export function verifyAdmin(username: string, password: string): AdminRecord | undefined {
  const admin = readAdmins().find((entry) => entry.enabled && entry.username === username);
  return admin && passwordMatches(admin, password) ? admin : undefined;
}

export function changeAdminPassword(username: string, currentPassword: string, newPassword: string): boolean {
  if (!currentPassword || !newPassword) throw new Error('currentPassword and newPassword are required.');
  const admins = readAdmins();
  const index = admins.findIndex((entry) => entry.enabled && entry.username === username);
  const admin = admins[index];
  if (!admin || !passwordMatches(admin, currentPassword)) return false;
  admins[index] = makeAdmin(admin.username, newPassword);
  writeAdmins(admins);
  return true;
}

function readAdmins(): AdminRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(config.adminsFile, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isAdminRecord) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function writeAdmins(admins: AdminRecord[]): void {
  mkdirSync(dirname(config.adminsFile), { recursive: true });
  writeFileSync(config.adminsFile, JSON.stringify(admins, null, 2), { mode: 0o600 });
}

function makeAdmin(username: string, password: string): AdminRecord {
  const salt = randomBytes(16).toString('hex');
  return {
    username,
    password_hash: scryptSync(password, salt, KEYLEN).toString('hex'),
    salt,
    role: 'admin',
    enabled: true,
  };
}

function passwordMatches(admin: AdminRecord, password: string): boolean {
  const candidate = scryptSync(password, admin.salt, KEYLEN);
  const expected = Buffer.from(admin.password_hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function isAdminRecord(value: unknown): value is AdminRecord {
  return Boolean(value) && typeof value === 'object' && typeof (value as AdminRecord).username === 'string';
}
