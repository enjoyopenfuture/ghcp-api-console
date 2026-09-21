import Database from 'better-sqlite3';

export async function withSqliteReadSnapshot<T>(source: Database.Database, read: (snapshot: Database.Database) => Promise<T>): Promise<T> {
  const snapshot = source.name === ':memory:'
    ? new Database(source.serialize())
    : new Database(source.name, { readonly: true, fileMustExist: true });
  try {
    snapshot.pragma('query_only = ON');
    snapshot.exec('BEGIN');
    return await read(snapshot);
  } finally {
    if (snapshot.inTransaction) snapshot.exec('ROLLBACK');
    snapshot.close();
  }
}
