import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createApp } from '../src/app';
import { CareService, activityWindow } from '../src/care';
import { Db } from '../src/db';
import { DevicesService, provisionDevice } from '../src/devices';
import { FencesService } from '../src/fences';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { ReportingService } from '../src/reporting';
import { TelemetryService } from '../src/telemetry';

import { demoPassword, demoOwnerEmail, demoViewerEmail } from '../src/demo-accounts';
export { demoPassword, demoOwnerEmail, demoViewerEmail } from '../src/demo-accounts';

export async function seedMvpDemo(db: Db) {
  if ((process.env.DATA_MODE ?? 'offline') !== 'offline') throw new Error('MVP 演示仅支持 offline 合成数据');
  if ((await db.get('SELECT COUNT(*) AS count FROM users'))!.count !== 0) throw new Error('MVP 演示需要空数据库');
  const app = await createApp({ db, quiet: true });
  try {
    const identity = app.get(IdentityService), care = app.get(CareService), telemetry = app.get(TelemetryService);
    const notifications = app.get(NotificationService), devices = app.get(DevicesService), reporting = app.get(ReportingService);
    const owner = await identity.register({ email: demoOwnerEmail, password: demoPassword, household_name: 'MVP 合成演示家庭', timezone: 'Asia/Shanghai' });
    const viewer = await identity.register({ email: demoViewerEmail, password: demoPassword, household_name: '只读账号的个人家庭', timezone: 'Asia/Shanghai' });
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: demoViewerEmail, role: 'viewer' });
    await identity.accept(viewer.user.id, invitation.token);
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '豆豆（合成演示）', species: 'dog', breed: '合成样例', birth_date: '2023-05-20' });
    const otherPet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '糯米（合成演示）', species: 'cat', breed: '换绑操作样例' });
    const device = await provisionDevice(db, { serial_no: `MVP-DEMO-${db.id()}` });
    await devices.claim(owner.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    await app.get(FencesService).create(owner.user.id, { pet_id: pet.id, name: '合成演示活动范围', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 }, confirm_points: 2 });
    const policy = await reporting.setPolicy(owner.user.id, device.device_id, { mode: 'home_active', interval_seconds: 120 });
    await reporting.acknowledge(device.device_id, policy.command_id, device.device_token, { status: 'applied', applied_version: policy.desired_version });
    const now = db.clock().getTime(), at = (milliseconds: number) => new Date(milliseconds).toISOString();
    let seq = 0;
    async function ingest(type: 'location.reported' | 'activity.reported' | 'state.reported', timestamp: number, payload: Record<string, unknown>) {
      await telemetry.ingest({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
        boot_id: 'mvp-synthetic-demo', seq: seq++, device_ts: at(timestamp), event_type: type,
        transport: 'simulator', firmware_version: 'synthetic-demo', source_metadata: { synthetic: true, purpose: 'MVP presentation' }, payload }, device.device_token);
    }
    const today = activityWindow(undefined, 'Asia/Shanghai', db.clock());
    const midnight = Date.parse(today.start), historicalSteps = [6200, 6800, 7200, 6500, 7000, 6300, 7500];
    for (let index = 0; index < historicalSteps.length; index++) {
      const start = midnight - (7 - index) * 86400_000, end = start + 86400_000;
      await ingest('activity.reported', end, { start_at: at(start), end_at: at(end), steps: historicalSteps[index], active_seconds: 3600 + index * 60, estimated: true, source: 'synthetic-demo' });
    }
    const elapsed = now - midnight;
    if (elapsed > 10_000) await ingest('activity.reported', now - 1000, { start_at: today.start, end_at: at(now - 1000),
      steps: Math.round(8000 * (elapsed - 1000) / 86400_000), active_seconds: Math.min(1800, Math.floor((elapsed - 1000) / 1000)), battery_pct: 78, estimated: true, source: 'synthetic-demo' });
    const points = [
      { seconds: -200, lat: 31.23, lon: 121.47 }, { seconds: -180, lat: 31.2301, lon: 121.4701 },
      { seconds: -160, lat: 31.232, lon: 121.47 }, { seconds: -140, lat: 31.2321, lon: 121.4701 },
      { seconds: -120, lat: 31.23, lon: 121.47 }, { seconds: -100, lat: 31.2301, lon: 121.47 },
      { seconds: -60, lat: 31.232, lon: 121.47 }, { seconds: -40, lat: 31.2321, lon: 121.4701 },
      { seconds: -20, lat: 31.2322, lon: 121.4702 }
    ];
    for (const point of points) await ingest('location.reported', now + point.seconds * 1000,
      { lat: point.lat, lon: point.lon, accuracy_m: 8, source: 'gnss', battery_pct: 78 });
    await ingest('state.reported', now, { battery_pct: 78 });
    await telemetry.work(100);
    await notifications.dispatch(100);
    const note = '纯合成样例，仅用于 MVP 软件展示，不代表真实宠物或项圈测量。';
    const careAt = (ago: number) => at(now - Math.min(ago, elapsed));
    await care.create(owner.user.id, { pet_id: pet.id, type: 'weight', value: { weight_kg: 8.6 }, recorded_at: careAt(3600_000), notes: note });
    await care.create(owner.user.id, { pet_id: pet.id, type: 'feeding', value: { food: '合成样例狗粮', amount_g: 80 }, recorded_at: careAt(2400_000), notes: note });
    await care.create(owner.user.id, { pet_id: pet.id, type: 'toileting', value: { kind: 'defecation', text: '合成日常记录' }, recorded_at: careAt(1800_000), notes: note });
    await care.create(owner.user.id, { pet_id: pet.id, type: 'custom', custom_type: '训练', value: { text: '合成样例：完成一次简单训练' }, recorded_at: careAt(1200_000), notes: note });
    const record = await care.create(owner.user.id, { pet_id: pet.id, type: 'note', value: { text: '欢迎体验 DOOGY MVP。可以编辑这条记录、查看历史并添加附件。' }, recorded_at: careAt(600_000), notes: note });
    const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    await care.uploadAttachment(owner.user.id, record.id, { filename: '合成演示图片.png' }, { originalname: 'synthetic-demo.png', mimetype: 'image/png', buffer: picture });
    return { synthetic: true, created_at: db.now(), owner: { email: demoOwnerEmail, password: demoPassword },
      viewer: { email: demoViewerEmail, password: demoPassword }, household_id: owner.household.id,
      pet_id: pet.id, other_pet_id: otherPet.id, device_id: device.device_id,
      activity_samples: historicalSteps.length + Number(elapsed > 10_000), location_points: points.length,
      events: await db.all('SELECT type,status FROM safety_events WHERE pet_id=? ORDER BY occurred_at,id', pet.id) };
  } finally { await app.close(); }
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function main() {
  const portArgument = process.argv[2];
  const port = portArgument === undefined ? await availablePort() : Number(portArgument);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('演示端口应为 1–65535 的整数');
  const directory = resolve('data', `mvp-demo-${randomUUID().replace(/-/g, '')}`);
  mkdirSync(directory, { recursive: true });
  const environment = { HOST: '127.0.0.1', PORT: String(port), DB_DRIVER: 'sqlite', DB_PATH: resolve(directory, 'doogy.db'),
    DATA_MODE: 'offline', DOOGY_DEMO: '1', MANAGED_BACKUP_ENABLED: 'false', FRESH_SECONDS: '1800', OFFLINE_SECONDS: '1800' };
  Object.assign(process.env, environment);
  for (const key of ['DATABASE_URL', 'PUSH_WEBHOOK_URL', 'PUSH_WEBHOOK_TOKEN', 'VENDOR_WEBHOOK_SECRET', 'SUPPORT_ADMIN_USER_IDS', 'DEVICE_ADMIN_USER_IDS']) delete process.env[key];
  writeFileSync(resolve(directory, 'demo.env'), Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\r\n') + '\r\n');
  const db = await Db.open({ driver: 'sqlite', path: environment.DB_PATH });
  let demo;
  try { demo = await seedMvpDemo(db); }
  finally { await db.close(); }
  writeFileSync(resolve(directory, 'demo.json'), JSON.stringify(demo, null, 2) + '\n');
  console.log('\n[DOOGY MVP] Synthetic data only / 以下账号、宠物、定位、活动和通知均为合成演示。');
  console.log(`[DOOGY MVP] 数据保存在独立目录：${directory}`);
  console.log(`[DOOGY MVP] 主人账号：${demo.owner.email}  密码：${demoPassword}`);
  console.log(`[DOOGY MVP] 只读账号：${demo.viewer.email}  密码：${demoPassword}`);
  console.log(`[DOOGY MVP] 演示入口：http://127.0.0.1:${port}/app/`);
  console.log('[DOOGY MVP] 合成位置与活动不会持续上报；演示新鲜度为 30 分钟，之后自然显示过期。');
  console.log('[DOOGY MVP] 每次执行创建新的隔离演示库，保留旧演示资料；用户 .env 和原数据库不变。\n');
  await import('./start');
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
