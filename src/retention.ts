import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';
import { IdentityService } from './identity';

const days = z.number().int().min(1).max(3650);
const passwordBody = z.object({ password: z.string().min(8).max(128) });
const policyBody = passwordBody.extend({ enabled: z.boolean(), telemetry_days: days.default(90), activity_days: days.default(365), safety_days: days.default(365) });
const defaults = { enabled: false, telemetry_days: 90, activity_days: 365, safety_days: 365, last_run_at: null };
type Cleanup = { name: string; table: string; where: string; params: string[]; update?: string };
const references = (value: unknown, ids: Set<string>): boolean => typeof value === 'string' ? ids.has(value)
  : Array.isArray(value) ? value.some(item => references(item, ids))
    : value !== null && typeof value === 'object' && Object.entries(value).some(([key, item]) => ids.has(key) || references(item, ids));

export class RetentionService {
  constructor(@Inject(Db) readonly db: Db) {}

  private async owner(user: string, household: string) {
    if ((await this.db.household(user, household)).role !== 'owner') fail(403, 'OWNER_REQUIRED', '只有家庭所有者可以设置或执行保留清理');
  }
  async read(user: string, household: string): Promise<Row> {
    await this.db.household(user, household);
    const policy = await this.db.get('SELECT * FROM household_retention WHERE household_id=?', household);
    return policy ? { ...policy, enabled: Boolean(policy.enabled) } : { household_id: household, ...defaults, updated_at: null };
  }
  async update(user: string, household: string, raw: unknown) {
    const input = policyBody.parse(raw);
    return this.db.transaction(async () => {
      await this.owner(user, household);
      await new IdentityService(this.db).verifyPassword(user, input.password);
      await this.db.run(`INSERT INTO household_retention(household_id,enabled,telemetry_days,activity_days,safety_days,updated_at,last_run_at)
        VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(household_id) DO UPDATE SET enabled=excluded.enabled,telemetry_days=excluded.telemetry_days,
        activity_days=excluded.activity_days,safety_days=excluded.safety_days,updated_at=excluded.updated_at,last_run_at=NULL`,
      household, Number(input.enabled), input.telemetry_days, input.activity_days, input.safety_days, this.db.now());
      const { password, ...policy } = input;
      await this.db.audit(user, 'retention.policy.updated', household, policy);
      return this.read(user, household);
    });
  }
  async preview(user: string, household: string) {
    return this.db.transaction(async () => { await this.owner(user, household); return this.run(household, true, true); });
  }
  async execute(user: string, household: string, raw: unknown) {
    const input = passwordBody.parse(raw);
    return this.db.transaction(async () => {
      await this.owner(user, household);
      await new IdentityService(this.db).verifyPassword(user, input.password);
      return this.run(household, false, true);
    });
  }

  private plan(household: string, telemetry: string, activity: string, safety: string, now: string): Cleanup[] {
    const pets = 'SELECT id FROM pets WHERE household_id=?';
    const oldLocations = `SELECT id FROM locations WHERE pet_id IN (${pets}) AND device_ts<?`;
    const oldSafety = `SELECT id FROM safety_events WHERE pet_id IN (${pets}) AND occurred_at<?`;
    const affectedActivityPets = `SELECT DISTINCT pet_id FROM activity_samples WHERE pet_id IN (${pets}) AND end_at<?`;
    return [
      { name: 'geofence_evaluations', table: 'geofence_evaluations', where: `location_id IN (${oldLocations})`, params: [household, telemetry] },
      { name: 'device_location_pointers', table: 'device_state', where: `last_location_id IN (${oldLocations})`, params: [household, telemetry], update: 'last_location_id=NULL' },
      { name: 'geofence_states', table: 'geofence_states', where: `fence_id IN (SELECT id FROM geofences WHERE pet_id IN (${pets}))
          AND (last_ts<? OR last_location_id IN (${oldLocations}) OR open_event_id IN (${oldSafety}))`, params: [household, telemetry, household, telemetry, household, safety],
        update: "status='unknown',candidate=NULL,count=0,candidate_since=NULL,last_ts=NULL,last_location_id=NULL,open_event_id=NULL,last_judgment='unknown'" },
      { name: 'safety_snapshots', table: 'safety_events', where: `pet_id IN (${pets}) AND ((occurred_at<? AND details_json<>'{}') OR location_id IN (${oldLocations}))`,
        params: [household, telemetry, household, telemetry], update: "details_json='{}',location_id=NULL" },
      { name: 'locations', table: 'locations', where: `pet_id IN (${pets}) AND device_ts<?`, params: [household, telemetry] },
      { name: 'activity_raw_metrics', table: 'activity_samples', where: `pet_id IN (${pets}) AND raw_metrics_json<>'{}'
          AND (end_at<? OR event_id IN (SELECT event_id FROM device_events WHERE pet_id IN (${pets}) AND received_at<?))`,
        params: [household, telemetry, household, telemetry], update: "raw_metrics_json='{}'" },
      { name: 'daily_summaries', table: 'daily_summaries', where: `pet_id IN (${affectedActivityPets})`, params: [household, activity] },
      { name: 'activity_observations', table: 'activity_observations', where: `pet_id IN (${affectedActivityPets})`, params: [household, activity] },
      { name: 'feedback_evidence', table: 'behavior_feedback', where: `pet_id IN (${affectedActivityPets}) AND evidence_json<>'{}'`, params: [household, activity], update: "evidence_json='{}'" },
      { name: 'activity_samples', table: 'activity_samples', where: `pet_id IN (${pets}) AND end_at<?`, params: [household, activity] },
      { name: 'notifications', table: 'notifications', where: `event_id IN (${oldSafety}) OR (created_at<? AND event_id IN (SELECT id FROM safety_events WHERE pet_id IN (${pets})))`, params: [household, safety, safety, household] },
      { name: 'safety_acknowledgements', table: 'safety_acknowledgements', where: `event_id IN (${oldSafety})`, params: [household, safety] },
      { name: 'safety_events', table: 'safety_events', where: `pet_id IN (${pets}) AND occurred_at<?`, params: [household, safety] },
      { name: 'telemetry_payloads', table: 'device_events', where: `pet_id IN (${pets}) AND received_at<? AND (payload_json<>'{}' OR envelope_json<>'{}' OR process_status IN ('pending','retry'))`,
        params: [household, telemetry], update: "payload_json='{}',envelope_json='{}',error=CASE WHEN process_status IN ('pending','retry') THEN 'RETENTION_EXPIRED' ELSE error END,process_status=CASE WHEN process_status IN ('pending','retry') THEN 'dead' ELSE process_status END" },
      { name: 'device_signal', table: 'device_state', where: `signal_json IS NOT NULL AND (EXISTS
          (SELECT 1 FROM device_events e JOIN pets p ON p.id=e.pet_id WHERE e.event_id=device_state.signal_event_id AND p.household_id=? AND e.received_at<?)
          OR (signal_event_id IS NULL AND COALESCE(reported_at,last_seen_at)<?
          AND device_id IN (SELECT b.device_id FROM device_bindings b JOIN pets p ON p.id=b.pet_id WHERE p.household_id=?
            AND NOT EXISTS (SELECT 1 FROM device_bindings active JOIN pets ap ON ap.id=active.pet_id
              WHERE active.device_id=b.device_id AND active.unbound_at IS NULL AND ap.household_id<>p.household_id))))`,
        params: [household, telemetry, telemetry, household], update: 'signal_json=NULL,signal_event_id=NULL' },
      { name: 'location_shares', table: 'location_shares', where: `pet_id IN (${pets}) AND (expires_at<=? OR revoked_at IS NOT NULL)`, params: [household, now] },
      { name: 'diagnostic_snapshots', table: 'support_tickets', where: `pet_id IN (${pets}) AND diagnostics_json IS NOT NULL AND (diagnostics_expires_at<=? OR diagnostics_revoked_at IS NOT NULL)`,
        params: [household, now], update: 'diagnostics_json=NULL' }
    ];
  }

  async run(householdId?: string, dryRun = false, force = false): Promise<Row> {
    const households = householdId ? [{ household_id: householdId }] : await this.db.all(`SELECT household_id FROM household_retention ${dryRun ? '' : 'WHERE enabled=1'} ORDER BY household_id`);
    const results: Row[] = [];
    for (const { household_id: household } of households) results.push(await this.db.transaction(async () => {
      const policy = await this.db.get('SELECT * FROM household_retention WHERE household_id=?', household), now = this.db.now();
      if (!policy || (!policy.enabled && !dryRun)) return { household_id: household, skipped: 'disabled', counts: {} };
      if (!force && policy.last_run_at && Date.parse(now) - Date.parse(policy.last_run_at) < 3600000) return { household_id: household, skipped: 'not_due', counts: {} };
      const cutoff = (days: number) => new Date(Date.parse(now) - days * 86400000).toISOString();
      const cutoffs = { telemetry: cutoff(policy.telemetry_days), activity: cutoff(policy.activity_days), safety: cutoff(policy.safety_days) };
      const plan = this.plan(household, cutoffs.telemetry, cutoffs.activity, cutoffs.safety, now), counts: Record<string, number> = {};
      for (const item of plan) counts[item.name] = (await this.db.get(`SELECT COUNT(*) AS count FROM ${item.table} WHERE ${item.where}`, ...item.params))!.count;
      const expired = new Set<string>();
      for (const [sql, params] of [
        ['SELECT id FROM locations WHERE pet_id IN (SELECT id FROM pets WHERE household_id=?) AND device_ts<?', [household, cutoffs.telemetry]],
        ['SELECT event_id AS id FROM device_events WHERE pet_id IN (SELECT id FROM pets WHERE household_id=?) AND received_at<?', [household, cutoffs.telemetry]],
        ['SELECT id FROM activity_samples WHERE pet_id IN (SELECT id FROM pets WHERE household_id=?) AND end_at<?', [household, cutoffs.activity]],
        [`SELECT id FROM safety_events WHERE pet_id IN (SELECT id FROM pets WHERE household_id=?) AND (occurred_at<? OR occurred_at<? OR location_id IN
          (SELECT id FROM locations WHERE pet_id IN (SELECT id FROM pets WHERE household_id=?) AND device_ts<?))`, [household, cutoffs.telemetry, cutoffs.safety, household, cutoffs.telemetry]]
      ] as [string, string[]][]) for (const row of await this.db.all(sql, ...params)) expired.add(row.id);
      const cachedIds = new Set(expired);
      if (Object.values(counts).some(count => count > 0)) {
        cachedIds.add(household);
        for (const pet of await this.db.all('SELECT id FROM pets WHERE household_id=?', household)) cachedIds.add(pet.id);
      }
      // shortcut: scan the current cache to find copies held by former members; add indexed scope columns when trial volume warrants it.
      const cached = (await this.db.all('SELECT * FROM idempotency_keys')).filter(row => references(JSON.parse(row.request_json), cachedIds)
        || references(JSON.parse(row.response_json), cachedIds));
      const audits = (await this.db.all("SELECT id,resource_id,metadata_json FROM audit_logs WHERE metadata_json<>'{}'")).filter(row => expired.has(row.resource_id) || references(JSON.parse(row.metadata_json), expired));
      counts.idempotency_keys = cached.length; counts.audit_metadata = audits.length;
      if (!dryRun) {
        for (const item of plan) if (counts[item.name]) await this.db.run(`${item.update ? `UPDATE ${item.table} SET ${item.update}` : `DELETE FROM ${item.table}`} WHERE ${item.where}`, ...item.params);
        for (const row of cached) await this.db.run('DELETE FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', row.user_id, row.scope, row.key);
        for (const row of audits) await this.db.run("UPDATE audit_logs SET metadata_json='{}' WHERE id=?", row.id);
        await this.db.run('UPDATE household_retention SET last_run_at=? WHERE household_id=?', now, household);
        if (Object.values(counts).some(count => count > 0)) await this.db.audit(null, 'retention.completed', household, { counts });
      }
      return { household_id: household, enabled: Boolean(policy.enabled), generated_at: now, cutoffs, counts };
    }));
    return { dry_run: dryRun, households: results };
  }
}

@ApiTags('data-lifecycle') @ApiBearerAuth() @Controller('households/:id/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}
  @Get() @Header('Cache-Control', 'no-store')
  read(@CurrentUser() user: string, @Param('id') household: string) { return this.retention.read(user, household); }
  @Patch() @JsonBody(policyBody)
  update(@CurrentUser() user: string, @Param('id') household: string, @Body() body: unknown) { return this.retention.update(user, household, body); }
  @Post('preview') @HttpCode(200) @Header('Cache-Control', 'no-store')
  preview(@CurrentUser() user: string, @Param('id') household: string) { return this.retention.preview(user, household); }
  @Post('run') @HttpCode(200) @JsonBody(passwordBody)
  run(@CurrentUser() user: string, @Param('id') household: string, @Body() body: unknown) { return this.retention.execute(user, household, body); }
}
