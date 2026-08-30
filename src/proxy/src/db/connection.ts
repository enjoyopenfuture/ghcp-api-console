import { readFileSync } from 'node:fs';
import { createPool, type PoolOptions } from 'mysql2/promise';
import { config } from '../config.js';
import { MysqlStorage } from './mysqlStorage.js';
import { SqliteStorage } from './sqliteStorage.js';
import type { ProxyStorage } from './storageTypes.js';

let storage: ProxyStorage | undefined;
let initialization: Promise<void> | undefined;

export function getStorage(): ProxyStorage {
  if (!storage) {
    storage = config.storageDriver === 'mysql'
      ? createMysqlStorage()
      : new SqliteStorage(config.dbPath, config.requestStatsPerAccountLimit);
  }
  return storage;
}

export function initializeStorage(): Promise<void> {
  if (!initialization) {
    initialization = getStorage().initialize().catch((err: unknown) => {
      initialization = undefined;
      throw err;
    });
  }
  return initialization;
}

export async function pingStorage(): Promise<void> {
  await initializeStorage();
  await getStorage().ping();
}

export async function closeStorage(): Promise<void> {
  if (!storage) return;
  await storage.close();
  storage = undefined;
  initialization = undefined;
}

function createMysqlStorage(): MysqlStorage {
  const poolOptions: PoolOptions = {
    uri: config.mysqlUrl!,
    connectionLimit: config.mysqlConnectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
    enableKeepAlive: true,
  };
  if (config.mysqlSslMode === 'required') {
    poolOptions.ssl = { rejectUnauthorized: false };
  } else if (config.mysqlSslMode === 'verify-ca') {
    poolOptions.ssl = {
      ca: readFileSync(config.mysqlSslCaPath!, 'utf8'),
      rejectUnauthorized: true,
    };
  }
  return new MysqlStorage(createPool(poolOptions), config.requestStatsPerAccountLimit);
}
