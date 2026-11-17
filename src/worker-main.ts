import { Db } from './db';
import { DevicesService } from './devices';
import { NotificationService } from './notifications';
import { TelemetryService } from './telemetry';
import { settings } from './config';
import { ReportingService } from './reporting';
import { SupportService } from './support';
import { RetentionService } from './retention';
import { InventoryRetentionService } from './inventory-retention';
import { BackupScheduler } from './backup-scheduler';

async function main() {
  settings();
  const db = await Db.open();
  const notifications = new NotificationService(db);
  const telemetry = new TelemetryService(db, new DevicesService(db), notifications);
  const reporting = new ReportingService(db);
  const support = new SupportService(db);
  const retention = new RetentionService(db);
  const inventoryRetention = new InventoryRetentionService(db);
  const backups = new BackupScheduler();
  let retentionCheck = 0;
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopped = true; });
  process.on('message', message => { if (message === 'shutdown') stopped = true; });
  if (process.connected) process.once('disconnect', () => { stopped = true; });
  console.log('DOOGY worker started');
  try {
    while (!stopped) {
      const batchSize = 100;
      await reporting.expire();
      await support.expireDiagnostics();
      if (Date.now() >= retentionCheck) {
        backups.tick();
        await db.expireIdempotency();
        await retention.run();
        await inventoryRetention.run();
        retentionCheck = Date.now() + 60_000;
      }
      const projected = await telemetry.work(batchSize);
      await telemetry.runMaintenance();
      const dispatched = await notifications.dispatch(batchSize);
      // A full batch may leave queued work; reserve the polling delay for idle/partial batches.
      if (projected < batchSize && dispatched < batchSize) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await backups.stop(); await db.close(); if (process.connected) process.disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
