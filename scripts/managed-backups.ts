import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { z } from 'zod';
import { snapshotDatabase } from './database-snapshot';
import { backupPostgres } from './postgres-backup';
import { settings } from '../src/config';

export type ManagedBackupOptions = { driver: 'sqlite' | 'postgres'; source: string; directory: string; keepCount: number; intervalHours: number };
const optionsSchema = z.object({ driver: z.enum(['sqlite','postgres']), source: z.string().min(1), directory: z.string().min(1),
  keepCount: z.number().int().min(1).max(365), intervalHours: z.number().int().min(1).max(720) });
const manifestSchema = z.object({ format: z.literal('doogy-managed-backup-v1'), verified: z.literal(true), id: z.uuid(),
  driver: z.enum(['sqlite','postgres']), source_id: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.iso.datetime(),
  files: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Catalog = { backups: Manifest[]; protected_entries: { id: string; reason: string }[] };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const names = (driver: 'sqlite' | 'postgres') => driver === 'sqlite' ? ['database.db','privacy-log.json'] : ['database.dump','database.dump.json','privacy-log.json'];

export function managedBackupOptions(): ManagedBackupOptions {
  const config = settings();
  return optionsSchema.parse({ driver: config.DB_DRIVER, source: config.DB_DRIVER === 'sqlite' ? process.env.DB_PATH ?? './data/doogy.db' : config.DATABASE_URL,
    directory: config.MANAGED_BACKUP_DIRECTORY, keepCount: config.MANAGED_BACKUP_KEEP_COUNT, intervalHours: config.MANAGED_BACKUP_INTERVAL_HOURS });
}
async function location(input: ManagedBackupOptions) {
  const options = optionsSchema.parse(input);
  let identity: string;
  if (options.driver === 'sqlite') identity = await realpath(resolve(options.source));
  else {
    const url = new URL(options.source);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) throw new Error('POSTGRES_DATABASE_URL_REQUIRED');
    if (['host','hostaddr','port','dbname','database','service','user'].some(key => url.searchParams.has(key))) throw new Error('POSTGRES_URL_ROUTING_OVERRIDE');
    identity = `${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
  }
  const source_id = digest(`${options.driver}|${identity}`), root = resolve(options.directory);
  return { ...options, source_id, root, bucket: join(root, `${options.driver}-${source_id}`) };
}
async function exists(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function hashFile(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) hash.update(bytes);
  return hash.digest('hex');
}
async function readBundle(bucket: string, id: string, source: string, driver: 'sqlite'|'postgres', verify = false): Promise<Manifest> {
  z.uuid().parse(id);
  const directory = join(bucket, id), stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_BUNDLE');
  const expected = [...names(driver), 'manifest.json'].sort(), actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('UNEXPECTED_FILES');
  for (const name of expected) {
    const item = await lstat(join(directory, name));
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('UNSAFE_FILE');
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')));
  if (manifest.id !== id || manifest.source_id !== source || manifest.driver !== driver
    || JSON.stringify(manifest.files.map(f=>f.name).sort()) !== JSON.stringify(names(driver).sort())) throw new Error('WRONG_BACKUP_SCOPE');
  if (verify) for (const file of manifest.files) {
    if ((await lstat(join(directory,file.name))).size !== file.bytes || await hashFile(join(directory,file.name)) !== file.sha256) throw new Error('BACKUP_CHECKSUM_MISMATCH');
  }
  return manifest;
}
async function catalog(info: Awaited<ReturnType<typeof location>>): Promise<Catalog> {
  const result: Catalog = { backups: [], protected_entries: [] }, bucket = await exists(info.bucket);
  if (!bucket) return result;
  if (!bucket.isDirectory() || bucket.isSymbolicLink()) throw new Error('UNSAFE_BACKUP_BUCKET');
  for (const id of await readdir(info.bucket)) {
    if (id === '.lock.sqlite' || id === '.lock.sqlite-journal') continue;
    try { result.backups.push(await readBundle(info.bucket,id,info.source_id,info.driver)); }
    catch { result.protected_entries.push({ id, reason: 'unrecognized_or_incomplete' }); }
  }
  result.backups.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
  return result;
}
export async function previewManagedBackups(options: ManagedBackupOptions) {
  const info = await location(options), found = await catalog(info);
  return { driver: info.driver, source_id: info.source_id, keep_count: info.keepCount, backups: found.backups,
    delete_after_next_backup: found.backups.slice(info.keepCount-1).map(b=>b.id), protected_entries: found.protected_entries,
    deletion_requires_successful_new_backup_and_checksum_verification: true };
}
async function privacyLog(options: ManagedBackupOptions) {
  let rows: Record<string, any>[];
  if (options.driver === 'sqlite') {
    const db = new DatabaseSync(resolve(options.source), { readOnly: true });
    try {
      rows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='privacy_deletions'").get()
        ? db.prepare('SELECT * FROM privacy_deletions ORDER BY deleted_at,id').all() : [];
    } finally { db.close(); }
  } else {
    const pool = new Pool({ connectionString: options.source, connectionTimeoutMillis: 10000 });
    try { rows = (await pool.query('SELECT * FROM privacy_deletions ORDER BY deleted_at,id')).rows; }
    finally { await pool.end(); }
  }
  const receipts = rows.map(row=>({ id: row.id, kind: row.kind, resource_id: row.resource_id, deleted_at: row.deleted_at,
    ...(row.kind === 'ownership_transfer' ? { payload: JSON.parse(row.payload_json) } : {}) }));
  return { format: 'doogy-privacy-log-v1', generated_at: new Date().toISOString(), receipts, sha256: digest(JSON.stringify(receipts)) };
}
export async function createManagedBackup(options: ManagedBackupOptions, run: { scheduled?: boolean; now?: Date; signal?: AbortSignal } = {}) {
  const info = await location(options), now = run.now ?? new Date();
  run.signal?.throwIfAborted();
  await mkdir(info.root, { recursive: true, mode: 0o700 });
  const root = await realpath(info.root);
  info.bucket = join(root, `${info.driver}-${info.source_id}`);
  const bucket = await exists(info.bucket);
  if (bucket && (!bucket.isDirectory() || bucket.isSymbolicLink())) throw new Error('UNSAFE_BACKUP_BUCKET');
  await mkdir(info.bucket, { recursive: true, mode: 0o700 });
  const lockPath = join(info.bucket,'.lock.sqlite'), lockStat = await exists(lockPath);
  if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) throw new Error('UNSAFE_BACKUP_LOCK');
  const lock = new DatabaseSync(lockPath);
  let held = false, directory: string | undefined, complete = false;
  const files = [...names(info.driver),'manifest.json','database.db-wal','database.db-shm'];
  try {
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); held = true; }
    catch (error) {
      if (((error as { errcode?: number }).errcode ?? 0) % 256 === 5) return { status: 'skipped', reason: 'busy', driver: info.driver, source_id: info.source_id, removed: [], protected_entries: [] };
      throw error;
    }
    const before = await catalog(info);
    if (run.scheduled && before.backups[0] && now.getTime()-Date.parse(before.backups[0].created_at) < info.intervalHours*3600000) {
      return { status: 'skipped', reason: 'not_due', driver: info.driver, source_id: info.source_id, removed: [], protected_entries: before.protected_entries };
    }
    const id = randomUUID(); directory = join(info.bucket,id);
    await mkdir(directory, { mode: 0o700 });
    if (info.driver === 'sqlite') {
      const target = join(directory,'database.db');
      await snapshotDatabase(info.source,target);
      // Seal the new copy as a standalone file; source WAL mode and contents stay unchanged.
      const copied = new DatabaseSync(target);
      try { copied.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); } finally { copied.close(); }
      await chmod(target,0o600);
    }
    else await backupPostgres(info.source,join(directory,'database.dump'), { signal: run.signal });
    run.signal?.throwIfAborted();
    await writeFile(join(directory,'privacy-log.json'),JSON.stringify(await privacyLog(info),null,2)+'\n',{flag:'wx',mode:0o600});
    const checked: Manifest['files'] = [];
    for (const name of names(info.driver)) checked.push({ name, bytes: (await lstat(join(directory,name))).size, sha256: await hashFile(join(directory,name),run.signal) });
    run.signal?.throwIfAborted();
    const manifest: Manifest = { format:'doogy-managed-backup-v1',verified:true,id,driver:info.driver,source_id:info.source_id,created_at:now.toISOString(),files:checked };
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600}); complete = true;
    const removed: string[] = [], protected_entries = [...before.protected_entries];
    let retained = 1;
    // Always keep this successful bundle, including when the system clock moved backwards.
    for (const old of before.backups) {
      try {
        run.signal?.throwIfAborted();
        await readBundle(info.bucket,old.id,info.source_id,info.driver,true);
        if (retained < info.keepCount) { retained++; continue; }
        for (const file of [...names(info.driver),'manifest.json']) await unlink(join(info.bucket,old.id,file));
        await rmdir(join(info.bucket,old.id)); removed.push(old.id);
      } catch { protected_entries.push({ id:old.id,reason:'checksum_changed_or_cleanup_failed' }); }
    }
    return { status:'completed',driver:info.driver,source_id:info.source_id,bundle:directory,removed,protected_entries };
  } catch (error) {
    if (directory && !complete) {
      await Promise.allSettled(files.map(name=>unlink(join(directory!,name))));
      await rmdir(directory).catch(()=>{});
    }
    throw error;
  } finally { if (held) lock.exec('ROLLBACK'); lock.close(); }
}
