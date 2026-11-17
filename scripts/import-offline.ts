import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Db } from '../src/db';
import { DevicesService } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { envelopeSchema, TelemetryService } from '../src/telemetry';
import { settings } from '../src/config';

export async function importOffline(db: Db, input: unknown, deviceToken: string) {
  if (settings().DATA_MODE !== 'offline') throw new Error('本地文件导入仅支持 DATA_MODE=offline');
  const events = z.array(envelopeSchema).min(1).max(10_000).parse(input);
  const notifications = new NotificationService(db);
  const telemetry = new TelemetryService(db, new DevicesService(db), notifications);
  let accepted = 0, duplicates = 0;
  for (const event of events) {
    const result = (await telemetry.ingest(event, deviceToken));
    result.duplicate ? duplicates++ : accepted++;
  }
  // Reuse the same durable queue and business processor as API mode.
  do { await telemetry.work(100); }
  while ((await db.get("SELECT event_id FROM device_events WHERE process_status IN ('pending','retry') AND next_attempt_at<=? LIMIT 1", db.now())));
  const dispatched = await notifications.dispatch();
  const statuses: Record<string, number> = {};
  for (const id of new Set(events.map(event => event.event_id))) {
    const status = (await db.get('SELECT process_status FROM device_events WHERE event_id=?', id))!.process_status as string;
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return { accepted, duplicates, statuses, notifications_processed: dispatched };
}

if (require.main === module) {
  (async () => {
    const filename = z.string().min(1).parse(process.argv[2]);
    const deviceToken = z.string().min(1).parse(process.env.DEVICE_TOKEN);
    const input = JSON.parse(readFileSync(filename, 'utf8'));
    const db = await Db.open();
    try {
      const result = await importOffline(db, input, deviceToken);
      console.log(JSON.stringify(result, null, 2));
      if (result.statuses.dead || result.statuses.retry) process.exitCode = 1;
    }
    finally { await db.close(); }
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
