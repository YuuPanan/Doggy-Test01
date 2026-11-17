import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function validate(database: DatabaseSync) {
  const check = database.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok') throw new Error('DATABASE_INTEGRITY_FAILED');
  if (database.prepare('PRAGMA foreign_key_check').get()) throw new Error('DATABASE_FOREIGN_KEYS_FAILED');
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('migrations','users','device_events')").all();
  if (tables.length !== 3) throw new Error('NOT_A_DOOGY_DATABASE');
}

export async function snapshotDatabase(sourceInput: string, targetInput: string) {
  const source = resolve(sourceInput), target = resolve(targetInput);
  if (!existsSync(source)) throw new Error('SOURCE_DATABASE_NOT_FOUND');
  if (existsSync(target)) throw new Error('TARGET_ALREADY_EXISTS: choose a new file; existing databases are never overwritten');
  const database = new DatabaseSync(source, { readOnly: true });
  let created = false;
  try {
    database.exec('PRAGMA busy_timeout=5000');
    validate(database);
    mkdirSync(dirname(target), { recursive: true });
    closeSync(openSync(target, 'wx'));
    created = true;
    // SQLite backup includes committed WAL data; a plain .db file copy may not.
    const pages = await backup(database, target);
    const restored = new DatabaseSync(target, { readOnly: true });
    try { validate(restored); } finally { restored.close(); }
    return { source, target, pages, integrity: 'ok', foreign_keys: 'ok', created_at: new Date().toISOString() };
  } catch (error) {
    if (created) for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(target + suffix); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup; }
    }
    throw error;
  } finally { database.close(); }
}
