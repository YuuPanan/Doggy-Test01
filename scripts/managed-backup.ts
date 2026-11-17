import { managedBackupOptions, createManagedBackup, previewManagedBackups } from './managed-backups';
import { settings } from '../src/config';

if (require.main === module) {
  const abort = new AbortController();
  process.on('message', message=>{ if (message === 'shutdown') abort.abort(); });
  if (process.connected) process.once('disconnect',()=>abort.abort());
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>abort.abort());
  (async()=>{
    const action = process.argv[2] || 'run';
    if (!['run','preview','scheduled'].includes(action)) throw new Error('Use run, preview, or scheduled');
    if (action === 'scheduled' && !settings().MANAGED_BACKUP_ENABLED) return {status:'skipped',reason:'disabled'};
    const options = managedBackupOptions();
    return action === 'preview' ? previewManagedBackups(options) : createManagedBackup(options,{scheduled:action==='scheduled',signal:abort.signal});
  })().then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{ console.error(abort.signal.aborted ? 'MANAGED_BACKUP_CANCELLED' : error instanceof Error ? error.message : 'MANAGED_BACKUP_FAILED'); process.exitCode=1; })
    .finally(()=>{if(process.connected)process.disconnect();});
}
