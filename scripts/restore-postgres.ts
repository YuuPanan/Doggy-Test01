import { restorePostgres } from './postgres-backup';

if (require.main === module) {
  (async () => {
    const [source, target] = process.argv.slice(2);
    if (!source || !target) throw new Error('Usage: npm run postgres:restore -- <backup.dump> <new_database_name>');
    if (process.env.DB_DRIVER !== 'postgres' || !process.env.DATABASE_URL) throw new Error('Select DB_DRIVER=postgres and DATABASE_URL using .env.postgres or environment variables');
    console.log(JSON.stringify(await restorePostgres(process.env.DATABASE_URL, source, target), null, 2));
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
