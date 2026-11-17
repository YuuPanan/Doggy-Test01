import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Pool, PoolClient, types } from 'pg';
import { z } from 'zod';
import { fail } from './http';
import { evaluateFence, Point } from './geofence-engine';
import { settings } from './config';

export type Row = Record<string, any>;
export type DbOptions = { driver?: 'sqlite' | 'postgres'; path?: string; url?: string; clock?: () => Date };
type TransactionContext = { client?: PoolClient };
types.setTypeParser(types.builtins.INT8, Number);
types.setTypeParser(types.builtins.NUMERIC, Number);

export function postgresSql(sql: string) {
  let result = '', parameter = 0, quote = '';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[index + 1] === quote) result += sql[++index];
        else quote = '';
      }
    } else if (char === "'" || char === '"') { quote = char; result += char; }
    else if (char === '?') result += `$${++parameter}${/^\s+IS\s+(?:NOT\s+)?NULL\b/i.test(sql.slice(index + 1)) ? '::text' : ''}`;
    else if (/^rowid\b/i.test(sql.slice(index)) && !/\w/.test(sql[index - 1] ?? '')) { result += '__sequence'; index += 4; }
    else if (sql.slice(index).startsWith('MAX(COALESCE(')) { result += 'GREATEST(COALESCE('; index += 'MAX(COALESCE('.length - 1; }
    else result += char;
  }
  return result;
}

export class Db {
  readonly driver: 'sqlite' | 'postgres';
  private readonly sqlite?: DatabaseSync;
  private readonly pool?: Pool;
  private readonly context = new AsyncLocalStorage<TransactionContext>();
  private queue = Promise.resolve();

  constructor(pathOrPool: string | Pool = process.env.DB_PATH ?? './data/doogy.db', readonly clock = () => new Date()) {
    this.driver = typeof pathOrPool === 'string' ? 'sqlite' : 'postgres';
    if (typeof pathOrPool !== 'string') { this.pool = pathOrPool; return; }
    if (pathOrPool !== ':memory:') mkdirSync(dirname(resolve(pathOrPool)), { recursive: true });
    this.sqlite = new DatabaseSync(pathOrPool);
    this.sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);');
    for (const file of readdirSync(resolve('db')).filter(f => f.endsWith('.sql')).sort()) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        if (!this.sqlite.prepare('SELECT name FROM migrations WHERE name=?').get(file)) {
          this.sqlite.exec(readFileSync(resolve('db', file), 'utf8'));
          this.sqlite.prepare('INSERT INTO migrations(name) VALUES (?)').run(file);
        }
        this.sqlite.exec('COMMIT');
      } catch (error) { this.sqlite.exec('ROLLBACK'); this.sqlite.close(); throw error; }
    }
  }

  static async open(options: DbOptions = {}) {
    const driver = z.enum(['sqlite', 'postgres']).parse(options.driver ?? process.env.DB_DRIVER ?? 'sqlite');
    if (driver === 'sqlite') return new Db(options.path ?? process.env.DB_PATH ?? './data/doogy.db', options.clock);
    const url = options.url ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for DB_DRIVER=postgres');
    try { if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) throw new Error(); }
    catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
    const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, application_name: 'doogy-backend' });
    const db = new Db(pool, options.clock);
    try {
      await db.transaction(async () => {
        await db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
        for (const file of readdirSync(resolve('db/postgres')).filter(f => f.endsWith('.sql')).sort()) {
          if (await db.get('SELECT name FROM migrations WHERE name=?', file)) continue;
          await db.exec(readFileSync(resolve('db/postgres', file), 'utf8'));
          await db.run('INSERT INTO migrations(name) VALUES (?)', file);
        }
      });
      return db;
    } catch (error) { await pool.end(); throw error; }
  }

  now() { return this.clock().toISOString(); }
  id() { return randomUUID(); }
  private async access<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.context.getStore() || this.pool) return work();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(done => { release = done; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  private async query(sql: string, params: SQLInputValue[]) {
    const client = this.context.getStore()?.client ?? this.pool!;
    return client.query(postgresSql(sql), params);
  }
  private rows<T>(rows: Row[]): T[] {
    return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('__')))) as T[];
  }
  async get<T = Row>(sql: string, ...params: SQLInputValue[]): Promise<T | undefined> {
    return this.access(async () => this.sqlite ? this.sqlite.prepare(sql).get(...params) as T | undefined : this.rows<T>((await this.query(sql, params)).rows)[0]);
  }
  async all<T = Row>(sql: string, ...params: SQLInputValue[]): Promise<T[]> {
    return this.access(async () => this.sqlite ? this.sqlite.prepare(sql).all(...params) as T[] : this.rows<T>((await this.query(sql, params)).rows));
  }
  async run(sql: string, ...params: SQLInputValue[]) {
    return this.access(async () => {
      if (this.sqlite) { const result = this.sqlite.prepare(sql).run(...params); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; }
      return { changes: (await this.query(sql, params)).rowCount ?? 0, lastInsertRowid: 0 };
    });
  }
  async exec(sql: string): Promise<void> {
    return this.access(async () => {
      if (this.sqlite) this.sqlite.exec(sql);
      else await (this.context.getStore()?.client ?? this.pool!).query(sql);
    });
  }
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active) {
      const name = `sp_${randomUUID().replace(/-/g, '')}`;
      await this.exec(`SAVEPOINT ${name}`);
      try { const result = await work(); await this.exec(`RELEASE SAVEPOINT ${name}`); return result; }
      catch (error) { await this.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
    }
    if (this.sqlite) return this.access(() => this.context.run({}, async () => {
      await this.exec('BEGIN IMMEDIATE');
      try { const result = await work(); await this.exec('COMMIT'); return result; }
      catch (error) { await this.exec('ROLLBACK'); throw error; }
    }));
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      // shortcut: preserve SQLite's single-writer ordering; use resource row locks when trial load needs parallel writers.
      await client.query('SELECT pg_advisory_xact_lock(1146048327,1)');
      return await this.context.run({ client }, async () => {
        const result = await work();
        await client.query('COMMIT');
        return result;
      });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async idempotent<T>(user: string, scope: string, key: string | undefined, input: unknown, work: () => T | Promise<T>): Promise<T> {
    if (key !== undefined) z.string().min(1).max(200).parse(key);
    const encoded = JSON.stringify(input);
    return this.transaction(async () => {
      if (key !== undefined) {
        const existing = await this.get('SELECT * FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', user, scope, key);
        if (existing && existing.created_at <= this.idempotencyCutoff()) {
          await this.run('DELETE FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', user, scope, key);
        } else if (existing) {
          if (!isDeepStrictEqual(JSON.parse(existing.request_json), JSON.parse(encoded))) fail(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同请求内容');
          return JSON.parse(existing.response_json) as T;
        }
      }
      const result = await work();
      if (key !== undefined) await this.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)', user, scope, key, encoded, JSON.stringify(result), this.now());
      return result;
    });
  }
  private idempotencyCutoff() {
    return new Date(this.clock().getTime() - settings().IDEMPOTENCY_TTL_HOURS * 3600000).toISOString();
  }
  async expireIdempotency(dryRun = false) {
    return this.transaction(async () => {
      const cutoff = this.idempotencyCutoff(), retention_hours = settings().IDEMPOTENCY_TTL_HOURS;
      const matched_records = (await this.get('SELECT COUNT(*) AS n FROM idempotency_keys WHERE created_at<=?', cutoff))!.n;
      const deleted_records = dryRun ? 0 : (await this.run('DELETE FROM idempotency_keys WHERE created_at<=?', cutoff)).changes;
      return { dry_run: dryRun, cutoff, retention_hours, matched_records, deleted_records };
    });
  }
  async household(userId: string, householdId: string, write = false) {
    const member = await this.get('SELECT * FROM household_members WHERE household_id=? AND user_id=?', householdId, userId);
    if (!member) fail(404, 'NOT_FOUND', '家庭不存在或无权访问');
    if (write && member.role === 'viewer') fail(403, 'READ_ONLY', '共享成员只有查看权限');
    return member;
  }
  async pet(userId: string, petId: string, write = false) {
    const pet = await this.get('SELECT * FROM pets WHERE id=?', petId);
    if (!pet) fail(404, 'NOT_FOUND', '宠物不存在');
    await this.household(userId, pet.household_id, write);
    return pet;
  }
  async audit(actorId: string | null, action: string, resourceId: string, metadata: Row = {}) {
    await this.run('INSERT INTO audit_logs VALUES (?,?,?,?,?,?)', this.id(), actorId, action, resourceId, JSON.stringify(metadata), this.now());
  }
  async recordDeletion(kind: string, resource: string, payload: Row = {}) {
    const last = (await this.get('SELECT MAX(deleted_at) AS time FROM privacy_deletions'))?.time;
    const time = last && last >= this.now() ? new Date(Date.parse(last) + 1).toISOString() : this.now();
    const row = { id: this.id(), deleted_at: time };
    await this.run('INSERT INTO privacy_deletions VALUES (?,?,?,?,?)', row.id, kind, resource, row.deleted_at, JSON.stringify(payload));
    return row;
  }
  async fenceSide(fence: Row, point: Point, bufferM: number): Promise<'inside' | 'outside' | 'uncertain'> {
    if (this.driver === 'sqlite') return evaluateFence(JSON.parse(fence.geometry_json), point, bufferM);
    const row = await this.get(`WITH point AS (SELECT ST_SetSRID(ST_MakePoint(?,?),4326) AS geom)
      SELECT CASE WHEN f.__radius_m IS NOT NULL THEN ST_Distance(f.__shape::geography,p.geom::geography)-f.__radius_m
        WHEN ST_Covers(f.__shape,p.geom) THEN -ST_Distance(ST_Boundary(f.__shape)::geography,p.geom::geography)
        ELSE ST_Distance(ST_Boundary(f.__shape)::geography,p.geom::geography) END AS distance
      FROM geofences f CROSS JOIN point p WHERE f.id=?`, point.lon, point.lat, fence.id);
    if (!row) fail(404, 'NOT_FOUND', '围栏不存在');
    if (bufferM > 0 && Math.abs(row.distance) <= bufferM) return 'uncertain';
    return row.distance <= 1e-7 ? 'inside' : 'outside';
  }
  async close() {
    if (this.pool) await this.pool.end();
    else await this.access(() => this.sqlite!.close());
  }
}
