import { Body, Controller, Get, Header, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { requireDeviceAdmin } from './device-credentials';
import { IdentityService } from './identity';
import { CurrentUser, JsonBody } from './http';

const policyId = 'unassigned_telemetry';
const passwordBody = z.object({ password: z.string().min(8).max(128) });
const policyBody = passwordBody.extend({ enabled: z.boolean(), telemetry_days: z.number().int().min(1).max(3650).default(7) });
const defaults = { id: policyId, enabled: false, telemetry_days: 7, updated_at: null, last_run_at: null };

export class InventoryRetentionService {
  constructor(@Inject(Db) readonly db: Db) {}
  async read(user: string): Promise<Row> {
    await requireDeviceAdmin(this.db, user);
    const row = await this.db.get('SELECT * FROM inventory_retention WHERE id=?', policyId);
    return row ? { ...row, enabled: Boolean(row.enabled) } : { ...defaults };
  }
  async update(user: string, raw: unknown) {
    const input = policyBody.parse(raw);
    return this.db.transaction(async () => {
      await requireDeviceAdmin(this.db, user);
      await new IdentityService(this.db).verifyPassword(user, input.password);
      await this.db.run(`INSERT INTO inventory_retention(id,enabled,telemetry_days,updated_at,last_run_at) VALUES (?,?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,telemetry_days=excluded.telemetry_days,updated_at=excluded.updated_at,last_run_at=NULL`,
      policyId, Number(input.enabled), input.telemetry_days, this.db.now());
      await this.db.audit(user, 'inventory.retention.updated', policyId, { enabled: input.enabled, telemetry_days: input.telemetry_days });
      return this.read(user);
    });
  }
  async preview(user: string) {
    return this.db.transaction(async () => { await requireDeviceAdmin(this.db, user); return this.run(true, true); });
  }
  async execute(user: string, raw: unknown) {
    const input = passwordBody.parse(raw);
    return this.db.transaction(async () => {
      await requireDeviceAdmin(this.db, user);
      await new IdentityService(this.db).verifyPassword(user, input.password);
      return this.run(false, true);
    });
  }
  async run(dryRun = false, force = false): Promise<Row> {
    return this.db.transaction(async () => {
      const policy = await this.db.get('SELECT * FROM inventory_retention WHERE id=?', policyId), now = this.db.now();
      if (!policy || (!policy.enabled && !dryRun)) return { dry_run: dryRun, enabled: false, skipped: 'disabled', counts: {} };
      if (!force && policy.last_run_at && Date.parse(now) - Date.parse(policy.last_run_at) < 3600000) {
        return { dry_run: dryRun, enabled: true, skipped: 'not_due', counts: {} };
      }
      const cutoff = new Date(Date.parse(now) - policy.telemetry_days * 86400000).toISOString();
      const events = "pet_id IS NULL AND received_at<? AND (payload_json<>'{}' OR envelope_json<>'{}' OR process_status IN ('pending','retry'))";
      const signals = `signal_json IS NOT NULL AND (EXISTS (SELECT 1 FROM device_events e WHERE e.event_id=device_state.signal_event_id
        AND e.device_id=device_state.device_id AND e.pet_id IS NULL AND e.received_at<?)
        OR (signal_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM device_bindings b WHERE b.device_id=device_state.device_id AND b.unbound_at IS NULL)))`;
      const counts = { telemetry_payloads: (await this.db.get(`SELECT COUNT(*) AS n FROM device_events WHERE ${events}`, cutoff))!.n,
        device_signal: (await this.db.get(`SELECT COUNT(*) AS n FROM device_state WHERE ${signals}`, cutoff))!.n };
      if (!dryRun) {
        await this.db.run(`UPDATE device_state SET signal_json=NULL,signal_event_id=NULL WHERE ${signals}`, cutoff);
        await this.db.run(`UPDATE device_events SET payload_json='{}',envelope_json='{}',
          error=CASE WHEN process_status IN ('pending','retry') THEN 'RETENTION_EXPIRED' ELSE error END,
          process_status=CASE WHEN process_status IN ('pending','retry') THEN 'dead' ELSE process_status END WHERE ${events}`, cutoff);
        await this.db.run('UPDATE inventory_retention SET last_run_at=? WHERE id=?', now, policyId);
        if (counts.telemetry_payloads || counts.device_signal) await this.db.audit(null, 'inventory.retention.completed', policyId, { cutoff, counts });
      }
      return { dry_run: dryRun, enabled: Boolean(policy.enabled), generated_at: now, cutoff, counts };
    });
  }
}

@ApiTags('inventory-retention') @ApiBearerAuth() @Controller('admin/retention/inventory')
export class InventoryRetentionController {
  constructor(private readonly retention: InventoryRetentionService) {}
  @Get() @Header('Cache-Control', 'no-store')
  read(@CurrentUser() user: string) { return this.retention.read(user); }
  @Patch() @JsonBody(policyBody)
  update(@CurrentUser() user: string, @Body() body: unknown) { return this.retention.update(user, body); }
  @Post('preview') @HttpCode(200) @Header('Cache-Control', 'no-store')
  preview(@CurrentUser() user: string) { return this.retention.preview(user); }
  @Post('run') @HttpCode(200) @JsonBody(passwordBody)
  execute(@CurrentUser() user: string, @Body() body: unknown) { return this.retention.execute(user, body); }
}
