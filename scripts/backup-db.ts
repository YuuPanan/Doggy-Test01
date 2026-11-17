import { resolve } from 'node:path';
import { snapshotDatabase } from './database-snapshot';

if (require.main === module) {
  if ((process.env.DB_DRIVER ?? 'sqlite') !== 'sqlite') {
    console.error('This command backs up SQLite only. Use postgres:backup for PostgreSQL; see docs/database.md.');
    process.exitCode = 1;
  } else {
    const target = process.argv[2] ?? resolve('data/backups', `doogy-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    snapshotDatabase(process.env.DB_PATH ?? './data/doogy.db', target)
      .then(result => console.log(JSON.stringify({ operation: 'backup', ...result }, null, 2)))
      .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
  }
}
