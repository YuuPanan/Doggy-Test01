import { Db } from '../src/db';
import { settings } from '../src/config';

async function main() {
  const config = settings();
  console.log(`[DOOGY] Storage: ${config.DB_DRIVER}; data mode: ${config.DATA_MODE}`);
  const db = await Db.open();
  try {
    await db.get('SELECT 1');
    console.log(`[DOOGY] ${db.driver} schema ready.`);
  } finally { await db.close(); }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.DB_DRIVER === 'postgres') console.error('[DOOGY] Check DATABASE_URL and server availability. For local Docker: npm run postgres:up');
  process.exitCode = 1;
});
