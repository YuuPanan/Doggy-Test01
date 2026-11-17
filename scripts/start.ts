import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(__dirname, '../..');
const children = new Set<ChildProcess>();
const input = createInterface({ input: process.stdin });
let stopping = false, ready = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  input.close();
  process.stdin.destroy();
  // IPC permits graceful shutdown on Windows, where child.kill() is forceful.
  for (const child of children) if (child.connected) child.send('shutdown', () => {});
  setTimeout(() => { for (const child of children) child.kill(); }, 8000).unref();
}

function launch(name: 'API' | 'WORKER', entry: string) {
  const child = spawn(process.execPath, [resolve(root, 'dist/src', entry)], {
    cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  children.add(child);
  console.log(`[DOOGY] ${name} pid=${child.pid}`);
  let output = '';
  child.stdout!.on('data', chunk => {
    process.stdout.write(`[${name}] ${chunk}`);
    if (name !== 'API' || ready || stopping) return;
    output += chunk.toString();
    const match = output.match(/DOOGY API (https?:\/\/\S+) \| Swagger \/docs/);
    if (match) {
      ready = true;
      output = '';
      console.log(`[DOOGY] API ready: ${match[1]}`);
      console.log(`[DOOGY] Swagger: ${match[1].replace(/\/api\/v1$/, '')}/docs`);
      console.log(`[DOOGY] App: ${match[1].replace(/\/api\/v1$/, '')}/app/`);
      launch('WORKER', 'worker-main.js');
    }
  });
  child.stderr!.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on('error', error => { console.error(`[DOOGY] ${name}: ${error.message}`); stop(1); });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[DOOGY] ${name} exited (${signal ?? code}); stopping this launch.`);
      stop(1);
    }
  });
}

process.chdir(root);
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
process.once('exit', () => { for (const child of children) child.kill(); });
input.once('line', () => stop(0));
console.log('[DOOGY] Press Enter or Ctrl+C to stop API and Worker.');
launch('API', 'main.js');
