import { z } from 'zod';
import { Db } from '../src/db';
import { provisionDevice } from '../src/devices';

async function main() {
  const serial_no = z.string().trim().min(1).max(100).parse(process.argv[2]);
  const db = await Db.open();
  try {
    const result = await provisionDevice(db, { serial_no, vendor: process.argv[3], model: process.argv[4] });
    // One-time local provisioning output; do not send this output to application logs.
    console.log(JSON.stringify(result, null, 2));
  } finally { await db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
