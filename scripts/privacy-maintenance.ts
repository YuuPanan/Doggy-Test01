import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Db, Row } from '../src/db';
import { deletionReceipt, PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { InventoryRetentionService } from '../src/inventory-retention';

const logSchema = z.object({ format: z.literal('doogy-privacy-log-v1'), generated_at: z.iso.datetime(), receipts: z.array(deletionReceipt), sha256: z.string() });
const checksum = (receipts: unknown) => createHash('sha256').update(JSON.stringify(receipts)).digest('hex');

export async function privacyMaintenance(db: Db, action: string, file?: string): Promise<Row> {
  if (action === 'idempotency-preview' || action === 'idempotency-clean') return db.expireIdempotency(action === 'idempotency-preview');
  if (action === 'retention-preview' || action === 'retention-run') return new RetentionService(db).run(undefined, action === 'retention-preview', true);
  if (action === 'inventory-preview' || action === 'inventory-run') return new InventoryRetentionService(db).run(action === 'inventory-preview', true);
  if (!file) throw new Error('A new export file or an existing replay file is required');
  const target = resolve(file), service = new PrivacyService(db);
  if (action === 'export-log') {
    const receipts = await service.receipts();
    const log = { format: 'doogy-privacy-log-v1', generated_at: db.now(), receipts, sha256: checksum(receipts) };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(log, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { operation: action, path: target, receipts: receipts.length, sha256: log.sha256 };
  }
  if (action === 'replay-log') {
    if ((process.env.DATA_MODE ?? 'offline') !== 'offline') throw new Error('Replay requires DATA_MODE=offline on an isolated restored database');
    const raw = JSON.parse(await readFile(target, 'utf8')), log = logSchema.parse(raw);
    // Validate before replay, but hash the stored representation before schema key reordering.
    if (checksum(raw.receipts) !== log.sha256) throw new Error('PRIVACY_LOG_CHECKSUM_MISMATCH');
    return { operation: action, ...await service.replay(log.receipts) };
  }
  throw new Error('Use retention-preview, retention-run, inventory-preview, inventory-run, idempotency-preview, idempotency-clean, export-log file, or replay-log file');
}

if (require.main === module) {
  (async () => {
    const action = process.argv[2] || 'retention-preview';
    if (!['retention-preview','retention-run','inventory-preview','inventory-run','idempotency-preview','idempotency-clean','export-log','replay-log'].includes(action)) throw new Error('Unknown privacy maintenance action');
    const db = await Db.open();
    try { console.log(JSON.stringify(await privacyMaintenance(db, action, process.argv[3]), null, 2)); }
    finally { await db.close(); }
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
