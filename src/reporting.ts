import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { settings } from './config';
import { CurrentUser, fail, JsonBody, Public } from './http';

const policySchema = z.object({
  mode: z.enum(['home_idle', 'home_active', 'boundary_watch', 'alert', 'low_power']),
  interval_seconds: z.number().int().min(15).max(86400),
  expires_in_seconds: z.number().int().min(30).max(3600).default(300)
});
const lostSchema = z.object({ enabled: z.boolean(), expires_in_seconds: z.number().int().min(60).max(86400).default(3600) });
const ackSchema = z.object({ status: z.enum(['applied', 'failed']), applied_version: z.number().int().positive(), error: z.string().max(200).optional() });
const defaultPolicy = { mode: 'home_active', interval_seconds: 120 };

export async function deviceTiming(db: Db, deviceId: string) {
  const config = settings();
  const policy = (await db.get(`SELECT p.* FROM reporting_policies p JOIN device_bindings b ON b.id=p.binding_id
    WHERE p.device_id=? AND b.unbound_at IS NULL`, deviceId));
  const applied = policy?.applied_json ? JSON.parse(policy.applied_json) : null;
  const interval: number | null = applied?.interval_seconds ?? null;
  return { offline_seconds: Math.max(config.OFFLINE_SECONDS, (interval ?? 0) * 3),
    fresh_seconds: Math.max(config.FRESH_SECONDS, (interval ?? 0) * 3), expected_interval_seconds: interval,
    source: policy?.applied_source ?? 'default' };
}

export async function clearDeviceReporting(db: Db, deviceId: string) {
  await db.run("UPDATE device_commands SET status='cancelled',error='DEVICE_UNBOUND' WHERE device_id=? AND status='pending'", deviceId);
  await db.run('UPDATE lost_mode_sessions SET ended_at=? WHERE device_id=? AND ended_at IS NULL', db.now(), deviceId);
  await db.run('DELETE FROM reporting_policies WHERE device_id=?', deviceId);
}

export class ReportingService {
  constructor(@Inject(Db) readonly db: Db) {}

  private async binding(deviceId: string) {
    const binding = (await this.db.get('SELECT * FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId));
    if (!binding) fail(404, 'NOT_FOUND', '设备未绑定');
    return binding;
  }
  private async authorize(user: string, deviceId: string, write = false) {
    const binding = (await this.binding(deviceId));
    await this.db.pet(user, binding.pet_id, write);
    return binding;
  }
  private async authenticate(deviceId: string, token?: string) {
    const device = (await this.db.get('SELECT secret_hash,credential_status FROM devices WHERE id=?', deviceId));
    const digest = createHash('sha256').update(token ?? '').digest('hex');
    if (!token || !device || device.credential_status !== 'active' || !timingSafeEqual(Buffer.from(digest), Buffer.from(device.secret_hash))) fail(401, 'DEVICE_UNAUTHENTICATED', '设备身份无效');
    return await this.binding(deviceId);
  }
  private async queue(deviceId: string, bindingId: string, policy: Row, ttl = 300) {
    const version = ((await this.db.get('SELECT MAX(version) AS n FROM device_commands WHERE device_id=?', deviceId))!.n ?? 0) + 1;
    const id = this.db.id(), now = this.db.now(), json = JSON.stringify(policy);
    await this.db.run("UPDATE device_commands SET status='superseded',error='NEWER_POLICY' WHERE device_id=? AND status='pending'", deviceId);
    await this.db.run('INSERT INTO device_commands(id,device_id,binding_id,version,policy_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?)',
      id, deviceId, bindingId, version, json, new Date(this.db.clock().getTime() + ttl * 1000).toISOString(), now);
    await this.db.run(`INSERT INTO reporting_policies(device_id,binding_id,desired_version,desired_json,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET binding_id=excluded.binding_id,desired_version=excluded.desired_version,
      desired_json=excluded.desired_json,updated_at=excluded.updated_at`, deviceId, bindingId, version, json, now);
    return (await this.db.get('SELECT * FROM device_commands WHERE id=?', id))!;
  }
  private commandView(command: Row): Row {
    const { policy_json, binding_id, ...rest } = command;
    return { ...rest, policy: JSON.parse(policy_json) };
  }
  async view(user: string, deviceId: string) {
    await this.authorize(user, deviceId);
    return await this.state(deviceId);
  }
  async state(deviceId: string) {
    const row = (await this.db.get('SELECT * FROM reporting_policies WHERE device_id=?', deviceId));
    const command = row ? (await this.db.get('SELECT * FROM device_commands WHERE device_id=? AND version=?', deviceId, row.desired_version)) : null;
    const lost = (await this.db.get('SELECT id,started_at,expires_at FROM lost_mode_sessions WHERE device_id=? AND ended_at IS NULL', deviceId));
    return { device_id: deviceId, desired_version: row?.desired_version ?? null, desired: row ? JSON.parse(row.desired_json) : null,
      applied_version: row?.applied_version ?? null, applied: row?.applied_json ? JSON.parse(row.applied_json) : null,
      execution_source: row?.applied_source ?? null,
      status: command ? command.status === 'pending' && command.expires_at <= this.db.now() ? 'expired' : command.status : 'unconfigured',
      command_id: command?.id ?? null, lost_mode: { enabled: Boolean(lost && lost.expires_at > this.db.now()), session: lost ?? null },
      timing: (await deviceTiming(this.db, deviceId)) };
  }
  async setPolicy(user: string, deviceId: string, raw: unknown, key?: string) {
    const input = policySchema.parse(raw);
    await this.authorize(user, deviceId, true);
    await this.expire();
    return await this.db.transaction(async () => {
      const binding = await this.authorize(user, deviceId, true);
      return this.db.idempotent(user, `PUT /devices/${deviceId}/reporting-policy`, key, { binding_id: binding.id, ...input }, async () => {
        if ((await this.db.get('SELECT id FROM lost_mode_sessions WHERE device_id=? AND ended_at IS NULL', deviceId))) fail(409, 'LOST_MODE_ACTIVE', '先关闭走失模式再修改普通上报策略');
        const { expires_in_seconds, ...policy } = input;
        await this.queue(deviceId, binding.id, policy, expires_in_seconds);
        await this.db.audit(user, 'device.policy_requested', deviceId, { mode: policy.mode });
        return await this.state(deviceId);
      });
    });
  }
  async lostMode(user: string, deviceId: string, raw: unknown, key?: string) {
    const input = lostSchema.parse(raw);
    await this.authorize(user, deviceId, true);
    await this.expire();
    return await this.db.transaction(async () => {
      const binding = await this.authorize(user, deviceId, true);
      return this.db.idempotent(user, `POST /devices/${deviceId}/lost-mode`, key, { binding_id: binding.id, ...input }, async () => {
        const active = (await this.db.get('SELECT * FROM lost_mode_sessions WHERE device_id=? AND ended_at IS NULL', deviceId));
        if (input.enabled && !active) {
          const previous = (await this.db.get('SELECT desired_json,applied_json FROM reporting_policies WHERE device_id=?', deviceId));
          const previousJson = previous?.desired_json ?? previous?.applied_json ?? JSON.stringify(defaultPolicy);
          await this.db.run('INSERT INTO lost_mode_sessions VALUES (?,?,?,?,?,?,NULL,?)', this.db.id(), deviceId, binding.id, user, this.db.now(),
            new Date(this.db.clock().getTime() + input.expires_in_seconds * 1000).toISOString(), previousJson);
          await this.queue(deviceId, binding.id, { mode: 'alert', interval_seconds: 15 }, Math.min(300, input.expires_in_seconds));
          await this.db.audit(user, 'device.lost_mode_started', deviceId);
        } else if (!input.enabled && active) {
          await this.restore(active);
          await this.db.audit(user, 'device.lost_mode_stopped', deviceId);
        }
        return await this.state(deviceId);
      });
    });
  }
  private async restore(session: Row) {
    await this.db.run('UPDATE lost_mode_sessions SET ended_at=? WHERE id=?', this.db.now(), session.id);
    const binding = (await this.db.get('SELECT id FROM device_bindings WHERE id=? AND unbound_at IS NULL', session.binding_id));
    if (binding) await this.queue(session.device_id, session.binding_id, JSON.parse(session.previous_policy_json));
  }
  async expire() {
    await this.db.transaction(async () => {
      await this.db.run("UPDATE device_commands SET status='expired',error='COMMAND_EXPIRED' WHERE status='pending' AND expires_at<=?", this.db.now());
      for (const session of (await this.db.all('SELECT * FROM lost_mode_sessions WHERE ended_at IS NULL AND expires_at<=?', this.db.now()))) {
        await this.restore(session);
        await this.db.audit(null, 'device.lost_mode_expired', session.device_id);
      }
    });
  }
  async command(user: string, deviceId: string, commandId: string) {
    const binding = (await this.authorize(user, deviceId));
    const command = (await this.db.get('SELECT * FROM device_commands WHERE id=? AND device_id=? AND binding_id=?', commandId, deviceId, binding.id));
    if (!command) fail(404, 'NOT_FOUND', '命令不存在');
    return this.commandView({ ...command, status: command.status === 'pending' && command.expires_at <= this.db.now() ? 'expired' : command.status });
  }
  async poll(deviceId: string, token?: string) {
    await this.authenticate(deviceId, token);
    await this.expire();
    return this.db.transaction(async () => {
      const binding = await this.authenticate(deviceId, token);
      const rows = await this.db.all("SELECT * FROM device_commands WHERE device_id=? AND binding_id=? AND status='pending' AND expires_at>? ORDER BY version", deviceId, binding.id, this.db.now());
      return { items: rows.map(row => this.commandView(row)) };
    });
  }
  async acknowledge(deviceId: string, commandId: string, token: string | undefined, raw: unknown) {
    const input = ackSchema.parse(raw);
    await this.authenticate(deviceId, token);
    await this.expire();
    return await this.db.transaction(async () => {
      const binding = await this.authenticate(deviceId, token);
      const command = (await this.db.get('SELECT * FROM device_commands WHERE id=? AND device_id=? AND binding_id=?', commandId, deviceId, binding.id));
      if (!command) fail(404, 'NOT_FOUND', '命令不存在');
      if (command.version !== input.applied_version) fail(409, 'VERSION_MISMATCH', '回执版本与命令不符');
      if (command.status === input.status) {
        if ((command.error ?? null) !== (input.status === 'failed' ? input.error ?? 'DEVICE_REJECTED' : null)) fail(409, 'ACK_CONFLICT', '该命令已有不同回执');
        return this.commandView(command);
      }
      const policy = (await this.db.get('SELECT desired_version FROM reporting_policies WHERE device_id=? AND binding_id=?', deviceId, binding.id));
      if (command.status !== 'pending' || command.expires_at <= this.db.now() || policy?.desired_version !== command.version)
        fail(409, 'COMMAND_NOT_CURRENT', '命令已过期、取消或被新策略替代');
      const source = settings().DATA_MODE === 'offline' ? 'simulator' : 'device';
      await this.db.run('UPDATE device_commands SET status=?,execution_source=?,error=?,acknowledged_at=? WHERE id=?', input.status, source,
        input.status === 'failed' ? input.error ?? 'DEVICE_REJECTED' : null, this.db.now(), commandId);
      if (input.status === 'applied') await this.db.run('UPDATE reporting_policies SET applied_version=?,applied_json=?,applied_source=?,updated_at=? WHERE device_id=?',
        command.version, command.policy_json, source, this.db.now(), deviceId);
      await this.db.audit(null, `device.command_${input.status}`, commandId, { execution_source: source });
      return this.commandView((await this.db.get('SELECT * FROM device_commands WHERE id=?', commandId))!);
    });
  }
}

@ApiTags('reporting') @ApiBearerAuth()
@Controller()
export class ReportingController {
  constructor(@Inject(ReportingService) readonly reporting: ReportingService) {}
  @Get('devices/:id/reporting-policy') async view(@CurrentUser() user: string, @Param('id') id: string) { return await this.reporting.view(user, id); }
  @Put('devices/:id/reporting-policy') @JsonBody(policySchema) @ApiHeader({ name: 'Idempotency-Key', required: false })
  async set(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return await this.reporting.setPolicy(user, id, body, key); }
  @Post('devices/:id/lost-mode') @JsonBody(lostSchema) @ApiHeader({ name: 'Idempotency-Key', required: false })
  async lost(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return await this.reporting.lostMode(user, id, body, key); }
  @Get('devices/:id/commands/:commandId') async command(@CurrentUser() user: string, @Param('id') id: string, @Param('commandId') cid: string) { return await this.reporting.command(user, id, cid); }
  @Public() @Get('device-ingress/:id/commands') @ApiHeader({ name: 'x-device-token', required: true })
  async poll(@Param('id') id: string, @Headers('x-device-token') token?: string) { return await this.reporting.poll(id, token); }
  @Public() @Post('device-ingress/:id/commands/:commandId/ack') @HttpCode(200) @JsonBody(ackSchema) @ApiHeader({ name: 'x-device-token', required: true })
  async ack(@Param('id') id: string, @Param('commandId') cid: string, @Headers('x-device-token') token: string | undefined, @Body() body: unknown) { return await this.reporting.acknowledge(id, cid, token, body); }
}
