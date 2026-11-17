import { z } from 'zod';
import { Db } from '../src/db';
import { ReportingService } from '../src/reporting';
import { settings } from '../src/config';

export async function simulateDevice(db: Db, deviceId: string, token: string) {
  if (settings().DATA_MODE !== 'offline') throw new Error('设备模拟回执仅支持 DATA_MODE=offline');
  const reporting = new ReportingService(db), commands = (await reporting.poll(deviceId, token)).items;
  return await Promise.all(commands.map(async command => (await reporting.acknowledge(deviceId, command.id, token, { status: 'applied', applied_version: command.version }))));
}
if (require.main === module) {
  (async () => {
    try {
      const deviceId = z.uuid().parse(process.argv[2]), token = z.string().min(1).parse(process.env.DEVICE_TOKEN), db = await Db.open();
      try { console.log(JSON.stringify({ commands: (await simulateDevice(db, deviceId, token)).map(({ id, version, status, execution_source }) => ({ id, version, status, execution_source })) }, null, 2)); }
      finally { await db.close(); }
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  })();
}
