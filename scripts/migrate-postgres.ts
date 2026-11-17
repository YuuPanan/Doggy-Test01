import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db, Row } from '../src/db';

export const legacyTables = [
  'audit_logs', 'users', 'households', 'household_members', 'pets', 'sessions', 'household_invitations', 'auth_attempts',
  'devices', 'device_bindings', 'device_state', 'device_events', 'locations', 'geofences', 'geofence_states',
  'geofence_evaluations', 'safety_events', 'activity_samples', 'notification_preferences', 'push_tokens', 'notifications',
  'care_records', 'care_record_revisions', 'behavior_feedback', 'idempotency_keys', 'safety_acknowledgements',
  'reporting_policies', 'device_commands', 'lost_mode_sessions', 'household_settings', 'pet_settings',
  'support_tickets', 'support_ticket_history', 'location_shares', 'activity_versions', 'daily_summaries', 'activity_observations'
];
export const lifecycleTables = [...legacyTables, 'household_retention', 'privacy_deletions'];
export const inventoryTables = [...lifecycleTables, 'inventory_retention'];
export const tables = [...inventoryTables, 'care_attachments'];
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error('UNSUPPORTED_IDENTIFIER');
  return `"${value}"`;
};
const fingerprint = (rows: Row[], columns: string[]) => createHash('sha256')
  .update(rows.map(row => JSON.stringify(columns.map(column => row[column]))).sort().join('\n')).digest('hex');

export async function migrateSqliteToPostgres(sourcePath: string, target: Db) {
  if (target.driver !== 'postgres') throw new Error('POSTGRES_TARGET_REQUIRED');
  const filename = resolve(sourcePath);
  if (!existsSync(filename)) throw new Error('SQLITE_SOURCE_NOT_FOUND');
  const source = new DatabaseSync(filename, { readOnly: true });
  try {
    source.exec('BEGIN');
    const actual = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'migrations'").all().map(row => String(row.name)).sort();
    if (![tables, inventoryTables, lifecycleTables, legacyTables].some(expected => JSON.stringify(actual) === JSON.stringify([...expected].sort()))) throw new Error('SQLITE_SCHEMA_NOT_CURRENT: run the SQLite application migrations first');
    if (!source.prepare("SELECT name FROM migrations WHERE name='013-grant-lifecycle.sql'").get()) throw new Error('SQLITE_SCHEMA_NOT_CURRENT');
    const integrity = source.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || source.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLITE_INTEGRITY_FAILED');
    return await target.transaction(async () => {
      for (const table of tables) {
        if (Number((await target.get(`SELECT COUNT(*) AS count FROM ${identifier(table)}`))!.count) !== 0) throw new Error(`POSTGRES_TARGET_NOT_EMPTY: ${table}`);
      }
      const report: Row[] = [];
      for (const table of tables) {
        if (!actual.includes(table)) {
          report.push({ table, rows: 0, sha256: createHash('sha256').digest('hex') });
          continue;
        }
        if (table === 'activity_versions') await target.run('DELETE FROM activity_versions');
        const info = source.prepare(`PRAGMA table_info(${identifier(table)})`).all();
        const columns = info.map(row => String(row.name));
        const primary = info.filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => String(row.name));
        if (!primary.length) throw new Error(`PRIMARY_KEY_REQUIRED: ${table}`);
        const selected = columns.map(identifier).join(',');
        let count = 0, batch: Row[] = [];
        const checksum = createHash('sha256');
        const flush = async () => {
          if (!batch.length) return;
          const values = batch.flatMap(row => columns.map(column => row[column]));
          await target.run(`INSERT INTO ${identifier(table)}(${selected}) VALUES ${batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`, ...values);
          const where = batch.map(() => `(${primary.map(key => `${identifier(key)}=?`).join(' AND ')})`).join(' OR ');
          const found = await target.all(`SELECT ${selected} FROM ${identifier(table)} WHERE ${where}`, ...batch.flatMap(row => primary.map(key => row[key])));
          const expectedHash = fingerprint(batch, columns);
          if (found.length !== batch.length || fingerprint(found, columns) !== expectedHash) throw new Error(`MIGRATION_DATA_MISMATCH: ${table}`);
          checksum.update(expectedHash);
          count += batch.length;
          batch = [];
        };
        for (const row of source.prepare(`SELECT ${selected} FROM ${identifier(table)} ORDER BY rowid`).iterate()) {
          batch.push(row);
          if (batch.length === (table === 'care_attachments' ? 1 : 200)) await flush();
        }
        await flush();
        if (Number((await target.get(`SELECT COUNT(*) AS count FROM ${identifier(table)}`))!.count) !== count) throw new Error(`MIGRATION_COUNT_MISMATCH: ${table}`);
        report.push({ table, rows: count, sha256: checksum.digest('hex') });
      }
      return { source: filename, target: 'postgres', verified: true, tables: report, total_rows: report.reduce((sum, row) => sum + row.rows, 0) };
    });
  } finally { source.close(); }
}

if (require.main === module) {
  (async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
    const target = await Db.open({ driver: 'postgres', url: process.env.DATABASE_URL });
    try { console.log(JSON.stringify(await migrateSqliteToPostgres(process.argv[2] ?? process.env.DB_PATH ?? './data/doogy.db', target), null, 2)); }
    finally { await target.close(); }
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
