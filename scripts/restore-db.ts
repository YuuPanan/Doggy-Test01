import { snapshotDatabase } from './database-snapshot';

if (require.main === module) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) {
    console.error('Usage: npm run db:restore -- <backup-file> <new-database-file>');
    process.exitCode = 1;
  } else snapshotDatabase(source, target)
    .then(result => console.log(JSON.stringify({ operation: 'restore', ...result }, null, 2)))
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
