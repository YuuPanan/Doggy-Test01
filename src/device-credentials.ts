import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';
import { credentialMetadata, hash } from './devices';
import { settings } from './config';

const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) });

export async function requireDeviceAdmin(db: Db, user: string) {
  const allowed = settings().DEVICE_ADMIN_USER_IDS.split(',').map(value => value.trim()).filter(Boolean);
  if (!allowed.includes(user) || !await db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', user)) fail(403, 'DEVICE_ADMIN_REQUIRED', '仅已配置的设备管理员可执行此操作');
}

export class DeviceCredentialsService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async owner(user: string, id: string) {
    const device = await this.db.get('SELECT * FROM devices WHERE id=? AND owner_user_id=?', id, user);
    if (!device) fail(404, 'NOT_FOUND', '设备不存在或非所有者');
    return device;
  }
  private async unclaimed(user: string, id: string) {
    await requireDeviceAdmin(this.db, user);
    const device = await this.db.get('SELECT * FROM devices WHERE id=?', id);
    if (!device) fail(404, 'NOT_FOUND', '设备不存在');
    if (device.owner_user_id || await this.db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', id)) fail(409, 'DEVICE_ALREADY_CLAIMED', '管理员仅可维护未认领且未绑定的设备');
    return device;
  }
  async view(user: string, id: string): Promise<Row> {
    const device = await this.owner(user, id);
    return { device_id: id, credential: credentialMetadata(device) };
  }
  private async replace(user: string, device: Row, reason: string) {
    const token = randomBytes(32).toString('base64url'), changed = this.db.now();
    await this.db.run(`UPDATE devices SET secret_hash=?,credential_version=credential_version+1,credential_status='active',credential_changed_at=? WHERE id=?`, hash(token), changed, device.id);
    await this.db.audit(user, 'device.credential.rotated', device.id, { reason, previous_version: device.credential_version, version: device.credential_version + 1 });
    // Never cache this one-time token in idempotency_keys or audit records.
    return { device_id: device.id, device_token: token, credential: { version: device.credential_version + 1, status: 'active', changed_at: changed } };
  }
  async rotate(user: string, id: string, raw: unknown): Promise<Row> {
    const input = reasonBody.parse(raw);
    return this.db.transaction(async () => this.replace(user, await this.owner(user, id), input.reason));
  }
  async revoke(user: string, id: string, raw: unknown): Promise<Row> {
    const input = reasonBody.parse(raw);
    return this.db.transaction(async () => {
      const device = await this.owner(user, id);
      if (device.credential_status !== 'revoked') {
        device.credential_status = 'revoked'; device.credential_changed_at = this.db.now();
        await this.db.run("UPDATE devices SET credential_status='revoked',credential_changed_at=? WHERE id=?", device.credential_changed_at, id);
        await this.db.audit(user, 'device.credential.revoked', id, { reason: input.reason, version: device.credential_version });
      }
      return { device_id: id, credential: credentialMetadata(device) };
    });
  }
  async adminRotate(user: string, id: string, raw: unknown): Promise<Row> {
    const input = reasonBody.parse(raw);
    return this.db.transaction(async () => this.replace(user, await this.unclaimed(user, id), input.reason));
  }
  async adminClaimCode(user: string, id: string, raw: unknown): Promise<Row> {
    const input = reasonBody.parse(raw);
    return this.db.transaction(async () => {
      await this.unclaimed(user, id);
      const code = randomBytes(16).toString('base64url'), expires = new Date(this.db.clock().getTime() + 30 * 60000).toISOString();
      await this.db.run('UPDATE devices SET claim_hash=?,claim_expires_at=?,claim_attempts=0 WHERE id=?', hash(code), expires, id);
      await this.db.audit(user, 'device.claim_code_reissued', id, { reason: input.reason });
      return { device_id: id, claim_code: code, claim_expires_at: expires };
    });
  }
}

@ApiTags('device-credentials') @ApiBearerAuth() @Controller()
export class DeviceCredentialsController {
  constructor(private readonly credentials: DeviceCredentialsService) {}
  @Get('devices/:id/credential') view(@CurrentUser() user: string, @Param('id') id: string) { return this.credentials.view(user, id); }
  @Post('devices/:id/credential/rotate') @JsonBody(reasonBody)
  rotate(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.credentials.rotate(user, id, body); }
  @Post('devices/:id/credential/revoke') @JsonBody(reasonBody)
  revoke(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.credentials.revoke(user, id, body); }
  @Post('admin/devices/:id/credential/rotate') @JsonBody(reasonBody)
  adminRotate(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.credentials.adminRotate(user, id, body); }
  @Post('admin/devices/:id/claim-code') @JsonBody(reasonBody)
  claimCode(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.credentials.adminClaimCode(user, id, body); }
}
