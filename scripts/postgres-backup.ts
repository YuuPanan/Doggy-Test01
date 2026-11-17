import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { promisify, isDeepStrictEqual } from 'node:util';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { inventoryTables, legacyTables, lifecycleTables, tables } from './migrate-postgres';

const execute = promisify(execFile);
const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const tableCheck = z.object({ table: z.string(), rows: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.object({
  format: z.literal('doogy-postgres-v1'), verified: z.literal(true), database: z.string(), created_at: z.string(),
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/), server_version: z.string(), postgis_version: z.string(),
  migrations: z.array(z.string()), tables: z.array(tableCheck)
});
export type PostgresManifest = z.infer<typeof manifestSchema>;

function connection(input: string) {
  const url = new URL(input);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) throw new Error('POSTGRES_DATABASE_URL_REQUIRED');
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service', 'user'].some(key => url.searchParams.has(key))) throw new Error('POSTGRES_URL_ROUTING_OVERRIDE: put server, port, user and database in the URL authority/path');
  return url;
}

async function toolCommand(tool: 'pg_dump' | 'pg_restore', input: string, args: string[]) {
  const url = connection(input);
  const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get('password') ?? '';
  url.password = ''; url.searchParams.delete('password');
  const env = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' };
  const mode = z.enum(['docker', 'native']).parse(process.env.PG_TOOLS ?? 'docker');
  if (mode === 'native') return { command: tool, args: [`--dbname=${url}`, ...args], env, password };
  const compose = resolve('compose.postgres.yml');
  const { stdout } = await execute('docker', ['compose', '-f', compose, 'ps', '--format', 'json', 'postgres'], { windowsHide: true });
  const services = stdout.trim().startsWith('[') ? JSON.parse(stdout) : stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const port = Number(url.port || 5432);
  if (url.hostname !== '127.0.0.1' || !services.some((service: any) =>
    service.State === 'running' && service.Publishers?.some((binding: any) => binding.TargetPort === 5432 && binding.PublishedPort === port && ['127.0.0.1', '0.0.0.0'].includes(binding.URL)))) {
    throw new Error('PG_TOOLS_DOCKER_ENDPOINT_MISMATCH: use the running DOOGY Compose endpoint, or PG_TOOLS=native');
  }
  url.hostname = '127.0.0.1'; url.port = '5432';
  return { command: 'docker', args: ['compose', '-f', compose, 'exec', '-T', '-e', 'PGPASSWORD', 'postgres', tool, `--dbname=${url}`, ...args], env, password };
}

async function runTool(tool: 'pg_dump' | 'pg_restore', url: string, args: string[], streams: { input?: Readable; output?: Writable; signal?: AbortSignal }) {
  let command: Awaited<ReturnType<typeof toolCommand>>;
  try { command = await toolCommand(tool, url, args); }
  catch (error) {
    await Promise.allSettled([streams.input, streams.output].filter(Boolean).map(stream => finished(stream!.destroy())));
    throw error;
  }
  const child = spawn(command.command, command.args, { env: command.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: streams.signal });
  // COPY failure context can contain account secrets or exact locations.
  child.stderr.resume();
  const closed = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? done() : reject(new Error(`${tool} failed (${code}): check tool/server versions, permissions and archive validity; row data is omitted`)));
  });
  if (!streams.input) child.stdin.end();
  if (!streams.output) child.stdout.resume();
  const transfers = [
    streams.input ? pipeline(streams.input, child.stdin) : Promise.resolve(),
    streams.output ? pipeline(child.stdout, streams.output) : Promise.resolve()
  ];
  try {
    await Promise.all([closed, ...transfers]);
  } catch (error) {
    child.kill(); child.stdin.destroy(); child.stdout.destroy();
    streams.input?.destroy(); streams.output?.destroy();
    await Promise.allSettled([closed, ...transfers]);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(command.password ? message.split(command.password).join('[redacted]') : message);
  }
}

async function archiveHash(filename: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function inspect(client: PoolClient, expectedMigrations = readdirSync(resolve('db/postgres')).filter(name => name.endsWith('.sql')).sort()) {
  const expectedTables = expectedMigrations.includes('010-care-attachments.sql') ? tables : expectedMigrations.includes('006-inventory-retention.sql') ? inventoryTables : expectedMigrations.includes('005-data-lifecycle.sql') ? lifecycleTables : legacyTables;
  const actual = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS
    (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype='e') ORDER BY c.relname`)).rows.map(row => row.relname);
  if (!isDeepStrictEqual(actual, [...expectedTables, 'migrations'].sort())) throw new Error('NOT_A_CURRENT_DOOGY_DATABASE');
  const migrations = (await client.query('SELECT name FROM migrations ORDER BY name')).rows.map(row => row.name as string);
  if (!isDeepStrictEqual(migrations, expectedMigrations)) throw new Error('POSTGRES_SCHEMA_NOT_CURRENT');
  const metadata = (await client.query('SELECT version() AS server_version, postgis_version() AS postgis_version')).rows[0];
  const checked: PostgresManifest['tables'] = [];
  for (const table of expectedTables) {
    const columns = (await client.query(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid=$1::regclass
      AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum`, [`public.${table}`])).rows.map(row => identifier(row.attname));
    const keys = (await client.query(`SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY k.position`, [`public.${table}`])).rows.map(row => `${identifier(row.attname)}::text COLLATE "C"`);
    if (!keys.length) throw new Error(`PRIMARY_KEY_REQUIRED: ${table}`);
    await client.query(`DECLARE doogy_backup_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS value
      FROM (SELECT ${columns.join(',')} FROM public.${identifier(table)} ORDER BY ${keys.join(',')}) t`);
    const digest = createHash('sha256');
    let count = 0;
    try {
      while (true) {
        const batch = (await client.query(`FETCH FORWARD ${table === 'care_attachments' ? 1 : 500} FROM doogy_backup_rows`)).rows;
        if (!batch.length) break;
        for (const row of batch) digest.update(row.value + '\n');
        count += batch.length;
      }
    } finally { await client.query('CLOSE doogy_backup_rows'); }
    checked.push({ table, rows: count, sha256: digest.digest('hex') });
  }
  return { ...metadata, migrations, tables: checked } as Pick<PostgresManifest, 'server_version' | 'postgis_version' | 'migrations' | 'tables'>;
}

export async function backupPostgres(url: string, targetInput: string, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const configured = connection(url), target = resolve(targetInput), manifest = `${target}.json`;
  const pool = new Pool({ connectionString: configured.toString(), connectionTimeoutMillis: 10000 });
  const created: string[] = [];
  let client: PoolClient | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true });
    for (const filename of [target, manifest]) { closeSync(openSync(filename, 'wx', 0o600)); created.push(filename); }
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // pg_dump and the manifest must observe exactly the same committed data while writers continue.
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const checked = await inspect(client);
    const file = await open(target, 'w');
    const dumpUrl = new URL(url), application = `doogy-backup-${randomUUID()}`;
    dumpUrl.searchParams.set('application_name', application);
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => { cancellation = pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()', [application]).catch(()=>{}); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await runTool('pg_dump', dumpUrl.toString(), ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`], { output: file.createWriteStream(), signal: options.signal });
    } finally { options.signal?.removeEventListener('abort', cancel); await cancellation; }
    await client.query('COMMIT');
    const report: PostgresManifest = { format: 'doogy-postgres-v1', verified: true,
      database: decodeURIComponent(configured.pathname.slice(1)), created_at: new Date().toISOString(),
      archive_sha256: await archiveHash(target), ...checked };
    await writeFile(manifest, JSON.stringify(report, null, 2) + '\n');
    return { ...report, archive: target, manifest };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    for (const filename of created) await unlink(filename);
    throw error;
  } finally { client?.release(); await pool.end(); }
}

export async function restorePostgres(url: string, sourceInput: string, targetDatabase: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(targetDatabase) || ['postgres', 'template0', 'template1'].includes(targetDatabase)) throw new Error('NEW_DATABASE_NAME_REQUIRED');
  const configured = connection(url), source = resolve(sourceInput);
  const saved = manifestSchema.parse(JSON.parse(await readFile(`${source}.json`, 'utf8')));
  const available = readdirSync(resolve('db/postgres')).filter(name => name.endsWith('.sql')).sort();
  // Verify an older archive at its saved version; normal startup applies later migrations.
  if (!saved.migrations.length || !isDeepStrictEqual(saved.migrations, available.slice(0, saved.migrations.length))) throw new Error('BACKUP_MIGRATIONS_UNSUPPORTED');
  const expectedTables = saved.migrations.includes('010-care-attachments.sql') ? tables : saved.migrations.includes('006-inventory-retention.sql') ? inventoryTables : saved.migrations.includes('005-data-lifecycle.sql') ? lifecycleTables : legacyTables;
  if (!isDeepStrictEqual(saved.tables.map(row => row.table).sort(), [...expectedTables].sort())) throw new Error('BACKUP_TABLES_MISMATCH');
  if (await archiveHash(source) !== saved.archive_sha256) throw new Error('BACKUP_CHECKSUM_MISMATCH');
  const header = await open(source, 'r');
  try { const magic = Buffer.alloc(5); await header.read(magic, 0, 5, 0); if (magic.toString() !== 'PGDMP') throw new Error('POSTGRES_CUSTOM_ARCHIVE_REQUIRED'); }
  finally { await header.close(); }
  const admin = new Pool({ connectionString: configured.toString(), connectionTimeoutMillis: 10000 });
  const targetUrl = new URL(configured); targetUrl.pathname = `/${targetDatabase}`;
  let created = false, restored: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${identifier(targetDatabase)} TEMPLATE template0`); created = true;
    await runTool('pg_restore', targetUrl.toString(), ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges'], { input: createReadStream(source) });
    restored = new Pool({ connectionString: targetUrl.toString(), connectionTimeoutMillis: 10000 });
    const client = await restored.connect();
    let checked: Awaited<ReturnType<typeof inspect>>;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      checked = await inspect(client, saved.migrations);
      await client.query('COMMIT');
    } finally { client.release(); }
    if (!isDeepStrictEqual(checked.tables, saved.tables) || !isDeepStrictEqual(checked.migrations, saved.migrations)) throw new Error('RESTORE_DATA_MISMATCH');
    return { operation: 'restore', verified: true, database: targetDatabase, archive: source,
      archive_sha256: saved.archive_sha256, ...checked, verified_at: new Date().toISOString() };
  } catch (error) {
    if (restored) { await restored.end(); restored = undefined; }
    if (created) {
      try {
        const deadline = Date.now() + 5000;
        while ((await admin.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [targetDatabase])).rows[0].n) {
          if (Date.now() >= deadline) throw new Error('RESTORE_CONNECTIONS_DID_NOT_CLOSE');
          await new Promise(done => setTimeout(done, 20));
        }
        await admin.query(`DROP DATABASE ${identifier(targetDatabase)}`);
      }
      catch { throw new Error(`RESTORE_FAILED_CLEANUP_REQUIRED: inspect newly created database ${targetDatabase}`); }
    }
    throw error;
  } finally { if (restored) await restored.end(); await admin.end(); }
}
