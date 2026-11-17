import { createApp } from './app';
import { Db } from './db';

async function main() {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await app.get(Db).close();
    if (process.connected) process.disconnect();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('message', message => { if (message === 'shutdown') void stop(); });
  if (process.connected) process.once('disconnect', () => { void stop(); });
  console.log(`DOOGY API ${await app.getUrl()}/api/v1 | Swagger /docs`);
  console.log(`DOOGY App ${await app.getUrl()}/app/`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
