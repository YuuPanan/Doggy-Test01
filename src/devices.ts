import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';
import { settings } from './config';
import { clearDeviceReporting, deviceTiming, ReportingService } from './reporting';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function credentialMetadata(device: Row) {
  return { version: device.credential_version, status: device.credential_status, changed_at: device.credential_changed_at ?? device.created_at };
}
export function verifySecret(value: string, stored: string) {
  const a = Buffer.from(hash(value));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function provisionDevice(db: Db, input: { serial_no: string; vendor?: string; model?: string; hardware_rev?: string }) {
  if ((await db.get('SELECT id FROM devices WHERE serial_no=?', input.serial_no))) fail(409, 'SERIAL_EXISTS', '设备序列号已存在');
  const deviceId = db.id(), deviceToken = randomBytes(32).toString('base64url'), claimCode = randomBytes(16).toString('base64url');
  const expires = new Date(db.clock().getTime() + 30 * 60_000).toISOString(), now = db.now();
  await db.transaction(async () => {
    await db.run('INSERT INTO devices(id,serial_no,vendor,model,hardware_rev,secret_hash,claim_hash,claim_expires_at,created_at,credential_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      deviceId, input.serial_no, input.vendor ?? 'simulator', input.model ?? 'DOOGY-dev', input.hardware_rev ?? null, hash(deviceToken), hash(claimCode), expires, now, now);
    await db.run('INSERT INTO device_state(device_id) VALUES (?)', deviceId);
    await db.audit(null, 'device.provisioned', deviceId);
  });
  return { device_id: deviceId, device_token: deviceToken, claim_code: claimCode, claim_expires_at: expires,
    credential: { version: 1, status: 'active', changed_at: now } };
}

export class DevicesService {
  constructor(@Inject(Db) readonly db: Db) {}
  async status(deviceId: string): Promise<Row> {
    const state = (await this.db.get('SELECT * FROM device_state WHERE device_id=?', deviceId))!;
    const location = state.last_location_id ? (await this.db.get('SELECT * FROM locations WHERE id=?', state.last_location_id)) : null;
    const config = settings(), now = this.db.clock().getTime(), timing = (await deviceTiming(this.db, deviceId));
    const online = !state.last_seen_at ? 'unknown' : now - Date.parse(state.last_seen_at) > timing.offline_seconds * 1000 ? 'offline' : 'online';
    const freshness = !location ? 'missing' : now - Date.parse(location.device_ts) > timing.fresh_seconds * 1000 ? 'stale' : 'fresh';
    return { ...state, signal: state.signal_json ? JSON.parse(state.signal_json) : null, signal_json: undefined, signal_event_id: undefined,
      connection_status: online, data_freshness: freshness, last_location_at: location?.device_ts ?? null,
      low_battery: state.battery_pct == null ? null : state.battery_pct <= config.LOW_BATTERY_PCT,
      timing, reporting: (await new ReportingService(this.db).state(deviceId)) };
  }
  async authorized(user: string, deviceId: string, write = false) {
    const binding = (await this.db.get('SELECT * FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId));
    if (!binding) fail(404, 'NOT_FOUND', '设备未绑定或无权访问');
    await this.db.pet(user, binding.pet_id, write);
    return binding;
  }
  async detail(user: string, id: string): Promise<Row> {
    const binding = (await this.authorized(user, id));
    const device = (await this.db.get('SELECT id,serial_no,vendor,model,hardware_rev,created_at,credential_version,credential_status,credential_changed_at FROM devices WHERE id=?', id))!;
    const { credential_version, credential_status, credential_changed_at, ...details } = device;
    return { ...details, credential: credentialMetadata(device), pet_id: binding.pet_id, state: (await this.status(id)) };
  }
  async claim(user: string, raw: unknown) {
    const input = claimSchema.parse(raw);
    await this.db.pet(user, input.pet_id, true);
    const device = (await this.db.get('SELECT * FROM devices WHERE id=?', input.device_id));
    if (!device) fail(404, 'NOT_FOUND', '设备不存在');
    if (device.claim_attempts >= 5) fail(429, 'CLAIM_LOCKED', '绑定码尝试次数已用完，请重新签发');
    if (!device.claim_hash || !device.claim_expires_at || device.claim_expires_at <= this.db.now()) fail(400, 'CLAIM_EXPIRED', '绑定码已失效');
    if (!verifySecret(input.claim_code, device.claim_hash)) {
      await this.db.run('UPDATE devices SET claim_attempts=claim_attempts+1 WHERE id=?', device.id);
      fail(400, 'INVALID_CLAIM', '绑定码不正确');
    }
    if (device.owner_user_id && device.owner_user_id !== user) fail(403, 'OWNER_TRANSFER_REQUIRED', '设备所有权转移需由原所有者释放');
    return await this.db.transaction(async () => {
      await this.db.pet(user, input.pet_id, true);
      const current = (await this.db.get('SELECT claim_hash,owner_user_id FROM devices WHERE id=?', device.id))!;
      if (current.claim_hash !== device.claim_hash || current.owner_user_id !== device.owner_user_id) fail(409, 'DEVICE_STATE_CHANGED', '设备状态已改变，请重新绑定');
      if ((await this.db.get('SELECT id FROM device_bindings WHERE unbound_at IS NULL AND (device_id=? OR pet_id=?)', device.id, input.pet_id))) fail(409, 'ALREADY_BOUND', '设备或宠物已有绑定');
      await this.db.run('INSERT INTO device_bindings VALUES (?,?,?,?,?,NULL)', this.db.id(), device.id, input.pet_id, user, this.db.now());
      await this.db.run('UPDATE devices SET owner_user_id=?,claim_hash=NULL,claim_expires_at=NULL WHERE id=?', user, device.id);
      // A new binding starts without the previous inventory or family's cached telemetry.
      await this.db.run(`UPDATE device_state SET last_location_id=NULL,last_seen_at=NULL,reported_at=NULL,reported_seq=NULL,reported_boot_id=NULL,
        battery_pct=NULL,signal_json=NULL,signal_event_id=NULL,firmware_version=NULL,connection_status='unknown' WHERE device_id=?`, device.id);
      await this.db.audit(user, 'device.claimed', device.id, { pet_id: input.pet_id });
      return await this.detail(user, device.id);
    });
  }
  async unbind(user: string, deviceId: string) {
    const device = (await this.db.get('SELECT * FROM devices WHERE id=? AND owner_user_id=?', deviceId, user));
    if (!device) fail(404, 'NOT_FOUND', '设备不存在或非所有者');
    const binding = (await this.db.get('SELECT * FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId));
    if (!binding) fail(409, 'NOT_BOUND', '设备没有当前绑定');
    const claimCode = randomBytes(16).toString('base64url');
    const expires = new Date(this.db.clock().getTime() + 30 * 60_000).toISOString();
    await this.db.transaction(async () => {
      const current = await this.db.get('SELECT id FROM devices WHERE id=? AND owner_user_id=?', deviceId, user);
      const active = await this.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId);
      if (!current || active?.id !== binding.id) fail(409, 'DEVICE_STATE_CHANGED', '设备绑定已改变，请刷新后重试');
      await this.db.run('UPDATE device_bindings SET unbound_at=? WHERE device_id=? AND unbound_at IS NULL', this.db.now(), deviceId);
      await this.db.run('UPDATE devices SET claim_hash=?,claim_expires_at=?,claim_attempts=0 WHERE id=?', hash(claimCode), expires, deviceId);
      await this.db.run(`UPDATE device_state SET last_location_id=NULL,last_seen_at=NULL,reported_at=NULL,reported_seq=NULL,reported_boot_id=NULL,
        battery_pct=NULL,signal_json=NULL,signal_event_id=NULL,firmware_version=NULL,connection_status='unknown' WHERE device_id=?`, deviceId);
      await clearDeviceReporting(this.db, deviceId);
      await this.db.run("UPDATE geofence_states SET status='unknown',candidate=NULL,count=0,candidate_since=NULL,last_ts=NULL,last_location_id=NULL,open_event_id=NULL,last_judgment='unknown' WHERE fence_id IN (SELECT id FROM geofences WHERE pet_id=?)", binding.pet_id);
      await this.db.run("UPDATE safety_events SET status='closed',closed_at=? WHERE device_id=? AND status='open'", this.db.now(), deviceId);
      await this.db.audit(user, 'device.unbound', deviceId);
    });
    return { device_id: deviceId, claim_code: claimCode, claim_expires_at: expires };
  }
  async release(user: string, deviceId: string) {
    return this.db.transaction(async () => {
      const device = await this.db.get('SELECT * FROM devices WHERE id=? AND owner_user_id=?', deviceId, user);
      if (!device) fail(404, 'NOT_FOUND', '设备不存在或非所有者');
      if (await this.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId)) fail(409, 'UNBIND_FIRST', '先解绑，再释放所有权');
      await this.db.run('UPDATE devices SET owner_user_id=NULL WHERE id=?', deviceId);
      await this.db.audit(user, 'device.ownership_released', deviceId);
      return { released: true };
    });
  }
  async renewClaimCode(user: string, deviceId: string) {
    const device = (await this.db.get('SELECT id FROM devices WHERE id=? AND owner_user_id=?', deviceId, user));
    if (!device) fail(404, 'NOT_FOUND', '设备不存在或非所有者');
    if ((await this.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId))) fail(409, 'UNBIND_FIRST', '先解绑再签发绑定码');
    const code = randomBytes(16).toString('base64url'), expires = new Date(this.db.clock().getTime() + 30 * 60_000).toISOString();
    await this.db.transaction(async () => {
      if (!(await this.db.get('SELECT id FROM devices WHERE id=? AND owner_user_id=?', deviceId, user))) fail(404, 'NOT_FOUND', '设备不存在或非所有者');
      if (await this.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', deviceId)) fail(409, 'UNBIND_FIRST', '先解绑再签发绑定码');
      await this.db.run('UPDATE devices SET claim_hash=?,claim_expires_at=?,claim_attempts=0 WHERE id=?', hash(code), expires, deviceId);
      await this.db.audit(user, 'device.claim_code_renewed', deviceId);
    });
    return { device_id: deviceId, claim_code: code, claim_expires_at: expires };
  }
}
const claimSchema = z.object({ device_id: z.string().uuid(), pet_id: z.string().uuid(), claim_code: z.string().min(1).max(200) });

@ApiTags('devices') @ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(@Inject(DevicesService) readonly devices: DevicesService) {}
  @Post('claim') @JsonBody(claimSchema)
  async claim(@CurrentUser() user: string, @Body() body: unknown) { return await this.devices.claim(user, body); }
  @Get(':id') async detail(@CurrentUser() user: string, @Param('id') id: string) { return await this.devices.detail(user, id); }
  @Post(':id/unbind') async unbind(@CurrentUser() user: string, @Param('id') id: string) { return await this.devices.unbind(user, id); }
  @Post(':id/release') async release(@CurrentUser() user: string, @Param('id') id: string) { return await this.devices.release(user, id); }
  @Post(':id/claim-code') async renew(@CurrentUser() user: string, @Param('id') id: string) { return await this.devices.renewClaimCode(user, id); }
}
