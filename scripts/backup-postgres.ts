import { resolve } from 'node:path';
import { backupPostgres } from './postgres-backup';

if (require.main === module) {
  (async () => {
    if (process.env.DB_DRIVER !== 'postgres' || !process.env.DATABASE_URL) throw new Error('Select DB_DRIVER=postgres and DATABASE_URL using .env.postgres or environment variables');
    const target = process.argv[2] || resolve('data/backups', `doogy-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
    console.log(JSON.stringify({ operation: 'backup', ...await backupPostgres(process.env.DATABASE_URL, target) }, null, 2));
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
