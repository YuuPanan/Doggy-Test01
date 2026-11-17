import { ChildProcess, execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { settings } from './config';

export class BackupScheduler {
  private child?: ChildProcess;
  private finished?: Promise<void>;
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly entry = resolve(__dirname, '../scripts/managed-backup.js')) {}

  tick(): void {
    if (this.stopping || this.child || !settings().MANAGED_BACKUP_ENABLED) return;
    const child = spawn(process.execPath, [this.entry, 'scheduled'], {
      env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.child = child;
    let output = '', startFailed = false;
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    // Tool diagnostics can contain source credentials; only fixed parent messages are logged.
    child.stderr!.resume();
    child.once('error', () => { startFailed = true; if (!this.stopping) console.error('[DOOGY] Managed backup failed (PROCESS_START_FAILED)'); });
    this.finished = new Promise(done => child.once('close', code => {
      this.child = undefined;
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          if (result.status === 'completed') console.log('[DOOGY] Managed backup completed');
          else if (result.status !== 'skipped' && !this.stopping) console.error('[DOOGY] Managed backup failed (INVALID_RESULT)');
        } catch { if (!this.stopping) console.error('[DOOGY] Managed backup failed (INVALID_RESULT)'); }
      } else if (!startFailed && !this.stopping) console.error('[DOOGY] Managed backup failed (PROCESS_FAILED)');
      done();
    }));
  }

  stop(): Promise<void> {
    this.stopping = true;
    return this.stopPromise ??= this.shutdown();
  }

  private async shutdown() {
    const child = this.child, finished = this.finished;
    if (!child || !finished) return;
    if (child.connected) child.send('shutdown', () => {});
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([finished.then(() => true), new Promise<false>(done => { timer = setTimeout(() => done(false), 5000); })]);
    clearTimeout(timer);
    if (exited || !child.pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>((done, reject) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode === null && child.signalCode === null) reject(new Error('MANAGED_BACKUP_STOP_FAILED'));
        else done();
      }));
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('MANAGED_BACKUP_STOP_FAILED'); }
    }
    await finished;
  }
}
