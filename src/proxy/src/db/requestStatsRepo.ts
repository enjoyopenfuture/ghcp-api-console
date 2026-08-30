import type { ProxyRequestStatDto } from '@ghcp/shared';
import { getStorage, initializeStorage } from './connection.js';
import type { RecordRequestStatInput } from './storageTypes.js';

export async function recordRequestStat(input: RecordRequestStatInput): Promise<void> {
  await initializeStorage();
  await getStorage().recordRequestStat(input);
}

export async function listRequestStats(identity?: string, limit = 100): Promise<ProxyRequestStatDto[]> {
  await initializeStorage();
  return getStorage().listRequestStats(identity, limit);
}

export async function pruneAllRequestStats(): Promise<void> {
  await initializeStorage();
  await getStorage().pruneAllRequestStats();
}
