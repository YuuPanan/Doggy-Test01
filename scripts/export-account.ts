import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { AccountExportService } from '../src/account-export';
import { Db, Row } from '../src/db';
import { IdentityService } from '../src/identity';

export async function exportAccount(db: Db, token: string, targetInput: string) {
  if (!token) throw new Error('DOOGY_ACCESS_TOKEN is required');
  const identity = new IdentityService(db), user = await identity.userFromAccess(token);
  const service = new AccountExportService(db), target = resolve(targetInput);
  await mkdir(dirname(target), { recursive: true });
  const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  let created = false, writeError: Error | undefined, rows = 0;
  output.on('error', error => { writeError = error; });
  const digest = createHash('sha256'), counts: { section: string; household_id: string | null; records: number }[] = [];
  const authenticate = async () => {
    if (await identity.userFromAccess(token) !== user) throw new Error('EXPORT_SESSION_CHANGED');
  };
  const line = async (value: Row) => {
    if (writeError) throw writeError;
    const text = JSON.stringify(value) + '\n';
    digest.update(text);
    if (!output.write(text)) await once(output, 'drain');
  };
  try {
    await once(output, 'open'); created = true;
    const manifest = await service.manifest(user);
    await line({ type: 'manifest', ...manifest });
    const scopes = [
      { household_id: null as string | null, sections: manifest.personal_sections as string[] },
      ...manifest.households.map((household: Row) => ({ household_id: household.id as string, sections: household.sections as string[] }))
    ];
    for (const scope of scopes) for (const section of scope.sections) {
      const count = { section, household_id: scope.household_id, records: 0 };
      let cursor: string | undefined;
      do {
        await authenticate();
        const page = await service.page(user, section, { household_id: scope.household_id ?? undefined, limit: 200,
          snapshot_at: manifest.generated_at, ...(cursor ? { cursor } : {}) });
        for (const data of page.items) {
          await line({ type: 'record', section, household_id: scope.household_id, data });
          rows++; count.records++;
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      counts.push(count);
    }
    await authenticate();
    const contentSha256 = digest.copy().digest('hex');
    await line({ type: 'complete', rows, counts, content_sha256: contentSha256, completed_at: db.now() });
    output.end(); await finished(output);
    return { path: target, rows, sections: counts.length, sha256: digest.digest('hex') };
  } catch (error) {
    output.destroy(); await finished(output).catch(() => {});
    if (created) await unlink(target);
    throw error;
  }
}

if (require.main === module) {
  (async () => {
    const token = process.env.DOOGY_ACCESS_TOKEN;
    if (!token) throw new Error('Set DOOGY_ACCESS_TOKEN to the logged-in account access token');
    const target = process.argv[2] || resolve('data/exports', `account-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
    const db = await Db.open();
    try { console.log(JSON.stringify(await exportAccount(db, token, target), null, 2)); }
    finally { await db.close(); }
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
