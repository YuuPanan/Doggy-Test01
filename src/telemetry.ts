import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { boundedRange, CurrentUser, dateTime, fail, JsonBody, pageQuery, Public } from './http';
import { DevicesService, verifySecret } from './devices';
import { settings } from './config';
import { advanceFence, distanceMeters, FenceState } from './geofence-engine';
import { NotificationService } from './notifications';
import { isDeepStrictEqual } from 'node:util';
import { latestLocation, locationPresenter } from './location-quality';
import { deviceTiming } from './reporting';

const statePayload = z.object({
  battery_pct: z.number().min(0).max(100).optional(),
  signal: z.record(z.string(), z.json()).optional()
});
const base = z.object({
  schema_version: z.literal('1.0'), event_id: z.string().min(8).max(128), device_id: z.uuid(),
  device_ts: dateTime, seq: z.number().int().nonnegative(), boot_id: z.string().min(1).max(100),
  firmware_version: z.string().max(100).optional(),
  transport: z.enum(['cellular', 'phone_gateway', 'vendor_cloud', 'simulator']).optional(),
  source_metadata: z.record(z.string(), z.json()).optional()
});
const locationPayload = statePayload.extend({
  lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracy_m: z.number().nonnegative().max(100_000),
  source: z.enum(['gnss', 'wifi', 'cellular', 'ble', 'vendor'])
});
const activityPayload = statePayload.extend({
  start_at: dateTime, end_at: dateTime,
  steps: z.number().int().nonnegative().nullable().optional(), active_seconds: z.number().nonnegative().nullable().optional(),
  distance_m: z.number().nonnegative().nullable().optional(), sleep_seconds: z.number().nonnegative().nullable().optional(),
  estimated: z.boolean().default(true), source: z.string().min(1).max(100).default('device'),
  raw_metrics: z.record(z.string(), z.json()).default({})
}).superRefine((p, ctx) => {
  const seconds = (Date.parse(p.end_at) - Date.parse(p.start_at)) / 1000;
  if (seconds <= 0 || seconds > 86400 || (p.active_seconds ?? 0) + (p.sleep_seconds ?? 0) > seconds)
    ctx.addIssue({ code: 'custom', message: '活动区间应为正数且不超过一天，活动与睡眠时长不能超出区间' });
  if ([p.steps, p.active_seconds, p.distance_m, p.sleep_seconds].every(v => v == null))
    ctx.addIssue({ code: 'custom', message: '至少提供一个设备实际测得的活动指标' });
});
export const envelopeSchema = z.discriminatedUnion('event_type', [
  base.extend({ event_type: z.literal('location.reported'), payload: locationPayload }),
  base.extend({ event_type: z.literal('state.reported'), payload: statePayload }),
  base.extend({ event_type: z.literal('activity.reported'), payload: activityPayload })
]);
type Envelope = z.infer<typeof envelopeSchema>;

export class TelemetryService {
  constructor(@Inject(Db) readonly db: Db, @Inject(DevicesService) readonly devices: DevicesService,
    @Inject(NotificationService) readonly notifications: NotificationService) {}

  async ingest(raw: unknown, deviceToken: string) { return await this.accept(raw, deviceToken); }
  async ingestVendor(raw: unknown) { return await this.accept(raw); }
  private async accept(raw: unknown, deviceToken?: string) {
    const event = envelopeSchema.parse(raw);
    const packet = JSON.stringify(event);
    return await this.db.transaction(async () => {
      const device = await this.db.get('SELECT secret_hash,credential_status FROM devices WHERE id=?', event.device_id);
      if (!device || device.credential_status !== 'active' || (deviceToken !== undefined && !verifySecret(deviceToken, device.secret_hash))) fail(401, 'DEVICE_UNAUTHENTICATED', '设备身份无效');
      const existing = (await this.db.get('SELECT * FROM device_events WHERE event_id=? OR (device_id=? AND boot_id=? AND seq=?)',
        event.event_id, event.device_id, event.boot_id, event.seq));
      if (existing) {
        if (existing.envelope_json === '{}') fail(409, 'EVENT_DATA_EXPIRED', '该事件原文已删除或超过保留期，不能重新接收');
        if (!isDeepStrictEqual(JSON.parse(existing.envelope_json), event)) fail(409, 'EVENT_CONFLICT', '事件 ID 或启动序列号已用于另一条消息');
        return { event_id: existing.event_id, status: existing.process_status, duplicate: true };
      }
      const binding = (await this.db.get('SELECT * FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', event.device_id));
      await this.db.run(`INSERT INTO device_events(event_id,device_id,pet_id,binding_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, event.event_id, event.device_id, binding?.pet_id ?? null, binding?.id ?? null,
        event.event_type, event.device_ts, this.db.now(), event.seq, event.boot_id, JSON.stringify(event.payload), packet, this.db.now());
      await this.db.run('UPDATE device_state SET last_seen_at=?,connection_status=? WHERE device_id=?', this.db.now(), 'online', event.device_id);
      return { event_id: event.event_id, status: 'pending', duplicate: false };
    });
  }
  async event(user: string, id: string): Promise<Row> {
    const event = (await this.db.get(`SELECT event_id,device_id,pet_id,type,device_ts,received_at,process_status,attempts,error,
      processing_started_at,processed_at FROM device_events WHERE event_id=?`, id));
    if (!event?.pet_id) fail(404, 'NOT_FOUND', '事件不存在');
    await this.db.pet(user, event.pet_id);
    return { ...event, ingest_delay_ms: Date.parse(event.received_at) - Date.parse(event.device_ts),
      queue_delay_ms: event.processing_started_at ? Date.parse(event.processing_started_at) - Date.parse(event.received_at) : null,
      processing_delay_ms: event.processed_at ? Date.parse(event.processed_at) - Date.parse(event.received_at) : null };
  }
  async work(limit = 100) {
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const result = (await this.db.transaction(async () => {
        const row = (await this.db.get("SELECT * FROM device_events WHERE process_status IN ('pending','retry') AND next_attempt_at<=? ORDER BY received_at,rowid LIMIT 1", this.db.now()));
        if (!row) return 'empty';
        await this.db.run('UPDATE device_events SET processing_started_at=COALESCE(processing_started_at,?) WHERE event_id=?', this.db.now(), row.event_id);
        await this.db.exec('SAVEPOINT projection');
        try {
          await this.process(row, envelopeSchema.parse(JSON.parse(row.envelope_json)));
          await this.db.run("UPDATE device_events SET process_status='processed',error=NULL,processed_at=? WHERE event_id=?", this.db.now(), row.event_id);
          await this.db.exec('RELEASE projection');
          return 'processed';
        } catch (error) {
          await this.db.exec('ROLLBACK TO projection; RELEASE projection');
          const attempts = row.attempts + 1;
          const permanent = error instanceof HttpException && error.getStatus() < 500;
          const reason = error instanceof HttpException ? (error.getResponse() as Row).code : error instanceof Error ? error.name : 'ProcessingError';
          await this.db.run('UPDATE device_events SET attempts=?,process_status=?,next_attempt_at=?,error=? WHERE event_id=?', attempts,
            permanent || attempts >= 5 ? 'dead' : 'retry', new Date(this.db.clock().getTime() + 2 ** attempts * 1000).toISOString(), reason, row.event_id);
          return 'failed';
        }
      }));
      if (result === 'empty') break;
      if (result === 'processed') processed++;
    }
    return processed;
  }
  private async process(row: Row, event: Envelope) {
    const binding = await this.db.get('SELECT * FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', event.device_id);
    // Queued inventory or former-binding messages must not update a later family's cache.
    if ((binding?.id ?? null) !== row.binding_id) return;
    if (binding) {
      const rebound = await this.db.get('SELECT id FROM device_bindings WHERE device_id=? AND id<>? LIMIT 1', event.device_id, binding.id);
      if (rebound && (event.device_ts < binding.bound_at || (event.event_type === 'activity.reported' && event.payload.start_at < binding.bound_at))) return;
    }
    const state = (await this.db.get('SELECT * FROM device_state WHERE device_id=?', event.device_id))!;
    const newer = !state.reported_at || event.device_ts > state.reported_at || (event.device_ts === state.reported_at && event.boot_id === state.reported_boot_id && event.seq > state.reported_seq);
    const notFuture = Date.parse(event.device_ts) <= Date.parse(row.received_at) + 60_000;
    await this.db.run('UPDATE device_state SET last_seen_at=MAX(COALESCE(last_seen_at,?),?),connection_status=? WHERE device_id=?',
      row.received_at, row.received_at, 'online', event.device_id);
    if (newer && notFuture) {
      await this.db.run(`UPDATE device_state SET reported_at=?,reported_seq=?,reported_boot_id=?,battery_pct=COALESCE(?,battery_pct),
        signal_json=COALESCE(?,signal_json),signal_event_id=COALESCE(?,signal_event_id),firmware_version=COALESCE(?,firmware_version) WHERE device_id=?`, event.device_ts, event.seq, event.boot_id,
        event.payload.battery_pct ?? null, event.payload.signal ? JSON.stringify(event.payload.signal) : null, event.payload.signal ? event.event_id : null,
        event.firmware_version ?? null, event.device_id);
    }
    // The binding captured on arrival prevents queued data moving into a later owner's pet.
    if (!binding) return;
    if ((await this.devices.status(event.device_id)).connection_status === 'online') await this.closeAlerts(binding.pet_id, 'device.offline');
    if (event.event_type === 'location.reported') await this.location(row, event);
    if (event.event_type === 'activity.reported') await this.activity(row, event);
    if (newer && notFuture && this.db.clock().getTime() - Date.parse(event.device_ts) <= (await deviceTiming(this.db, event.device_id)).fresh_seconds * 1000 && event.payload.battery_pct !== undefined) {
      if (event.payload.battery_pct <= settings().LOW_BATTERY_PCT)
        await this.emitSafety(binding.pet_id, event.device_id, 'battery.low', event.device_ts, null, null, { battery_pct: event.payload.battery_pct });
      else await this.closeAlerts(binding.pet_id, 'battery.low');
    }
  }
  private async location(row: Row, event: Extract<Envelope, { event_type: 'location.reported' }>) {
    const p = event.payload, flags: string[] = [];
    const freshMs = (await deviceTiming(this.db, event.device_id)).fresh_seconds * 1000;
    const age = Date.parse(row.received_at) - Date.parse(event.device_ts);
    if (age > freshMs) flags.push('stale');
    if (age < -60_000) flags.push('clock_ahead');
    if (p.accuracy_m > 100) flags.push('poor_accuracy');
    const previous = (await this.db.get(`SELECT l.* FROM locations l JOIN device_state s ON s.last_location_id=l.id WHERE s.device_id=?`, event.device_id));
    const speedReference = (await this.db.get(`SELECT l.* FROM locations l JOIN device_events e ON e.event_id=l.event_id
      WHERE l.device_id=? AND e.binding_id=? AND l.device_ts<? AND l.source='gnss' AND l.accuracy_m<=100
      AND l.quality_flags_json='[]' ORDER BY l.device_ts DESC,l.id DESC LIMIT 1`, event.device_id, row.binding_id, event.device_ts));
    if (speedReference) {
      const seconds = (Date.parse(event.device_ts) - Date.parse(speedReference.device_ts)) / 1000;
      if (distanceMeters(speedReference as any, p) / seconds > 80) flags.push('implausible_speed');
    }
    const id = this.db.id();
    await this.db.run('INSERT INTO locations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, event.event_id, event.device_id, row.pet_id,
      event.device_ts, row.received_at, p.lat, p.lon, p.accuracy_m, p.source, event.seq, event.boot_id, JSON.stringify(flags));
    if (!flags.includes('clock_ahead') && (!previous || event.device_ts > previous.device_ts)) {
      await this.db.run('UPDATE device_state SET last_location_id=? WHERE device_id=?', id, event.device_id);
      if (flags.length === 0 && p.source === 'gnss' && this.db.clock().getTime() - Date.parse(event.device_ts) <= freshMs) await this.closeAlerts(row.pet_id, 'location.stale');
    }
    for (const fence of (await this.db.all('SELECT * FROM geofences WHERE pet_id=? AND enabled=1', row.pet_id))) {
      const state = (await this.db.get('SELECT * FROM geofence_states WHERE fence_id=?', fence.id))!;
      const buffer = fence.dynamic_buffer ? Math.max(fence.buffer_m, p.accuracy_m, fence.min_buffer_m) : fence.buffer_m;
      const record = async (judgment: string, reason: string, snapshot: Row) => (await this.db.run(`INSERT INTO geofence_evaluations
        (id,fence_id,location_id,judgment,state_json,evaluated_at,rule_version,reason,effective_buffer_m) VALUES (?,?,?,?,?,?,?,?,?)`,
        this.db.id(), fence.id, id, judgment, JSON.stringify(snapshot), this.db.now(), fence.rule_version, reason, buffer));
      if (flags.includes('clock_ahead')) {
        await this.db.run("UPDATE geofence_states SET candidate=NULL,candidate_since=NULL,count=0,last_judgment='uncertain' WHERE fence_id=?", fence.id);
        await record('uncertain', 'clock_ahead', { status: state.status, candidate: null, candidate_since: null, count: 0 });
        continue;
      }
      if (state.last_ts && event.device_ts <= state.last_ts) {
        await record('skipped', 'out_of_order', state);
        continue;
      }
      const freshNow = this.db.clock().getTime() - Date.parse(event.device_ts) <= freshMs;
      let reason = !freshNow || flags.includes('stale') ? 'stale' : flags.includes('implausible_speed') ? 'implausible_speed'
        : p.accuracy_m > fence.accuracy_limit_m ? 'poor_accuracy' : p.source !== 'gnss' ? 'source_not_allowed' : 'valid';
      const judgment = reason !== 'valid' ? 'uncertain' : (await this.db.fenceSide(fence, p, buffer));
      if (reason === 'valid' && judgment === 'uncertain') reason = 'boundary_buffer';
      const gap = state.last_ts && Date.parse(event.device_ts) - Date.parse(state.last_ts) > freshMs;
      const consecutive: FenceState = { status: state.status, candidate: gap ? null : state.candidate, count: gap ? 0 : state.count };
      const since = !gap && consecutive.candidate === judgment && state.candidate_since ? state.candidate_since : event.device_ts;
      const minimumSeconds = judgment === 'outside' ? fence.min_exit_seconds : fence.min_enter_seconds;
      const elapsed = (Date.parse(event.device_ts) - Date.parse(since)) / 1000;
      const required = elapsed < minimumSeconds ? Number.MAX_SAFE_INTEGER : fence.confirm_points;
      const { state: next, transition } = advanceFence(consecutive, judgment, required);
      const candidateSince = next.candidate ? since : null;
      let openEvent = state.open_event_id;
      if (transition) {
        const related = transition === 'entered' ? openEvent : null;
        const alert = (await this.emitSafety(row.pet_id, event.device_id, `geofence.${transition}`, event.device_ts, id, fence.id,
          { accuracy_m: p.accuracy_m, source: p.source, rule_version: fence.rule_version,
            effective_buffer_m: buffer, device: (await this.devices.status(event.device_id)) }, related));
        if (transition === 'exited') openEvent = alert;
        else {
          if (openEvent) await this.db.run("UPDATE safety_events SET status='closed',closed_at=? WHERE id=?", event.device_ts, openEvent);
          openEvent = null;
        }
      }
      await this.db.run('UPDATE geofence_states SET status=?,candidate=?,candidate_since=?,count=?,last_ts=?,last_location_id=?,open_event_id=?,last_judgment=? WHERE fence_id=?',
        next.status, next.candidate, candidateSince, next.count, event.device_ts, id, openEvent, judgment, fence.id);
      await record(judgment, reason, { ...next, candidate_since: candidateSince });
    }
  }
  private async activity(row: Row, event: Extract<Envelope, { event_type: 'activity.reported' }>) {
    const p = event.payload;
    if (Date.parse(p.end_at) > Date.parse(event.device_ts) + 60_000) fail(400, 'ACTIVITY_TIME_INVALID', '活动结束时间超过设备采样时间');
    // Replacement devices must not double-count an existing pet's interval totals.
    if ((await this.db.get('SELECT id FROM activity_samples WHERE pet_id=? AND start_at<? AND end_at>?', row.pet_id, p.end_at, p.start_at)))
      fail(409, 'ACTIVITY_OVERLAP', '活动区间已存在');
    await this.db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', this.db.id(), event.event_id, event.device_id, row.pet_id,
      p.start_at, p.end_at, p.steps ?? null, p.active_seconds ?? null, p.distance_m ?? null, p.sleep_seconds ?? null,
      Number(p.estimated), p.source, JSON.stringify(p.raw_metrics));
  }
  async closeAlerts(petId: string, type: string) {
    await this.db.run("UPDATE safety_events SET status='closed',closed_at=? WHERE pet_id=? AND type=? AND status='open'", this.db.now(), petId, type);
  }
  async emitSafety(petId: string, deviceId: string, type: string, when: string, locationId: string | null, fenceId: string | null,
    details: Row, related: string | null = null) {
    if (!type.startsWith('geofence.')) {
      const existing = (await this.db.get("SELECT id FROM safety_events WHERE pet_id=? AND type=? AND status='open'", petId, type));
      if (existing) return existing.id as string;
    }
    const id = this.db.id(), instant = type === 'geofence.entered';
    await this.db.run(`INSERT INTO safety_events(id,pet_id,device_id,fence_id,type,occurred_at,location_id,details_json,status,closed_at,related_event_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, petId, deviceId, fenceId, type, when, locationId,
      JSON.stringify(details), instant ? 'closed' : 'open', instant ? when : null, related);
    await this.notifications.enqueue(id);
    return id;
  }
  async runMaintenance() {
    await this.db.transaction(async () => {
      for (const binding of (await this.db.all('SELECT * FROM device_bindings WHERE unbound_at IS NULL'))) {
        const state = (await this.devices.status(binding.device_id));
        if (state.connection_status === 'offline') await this.emitSafety(binding.pet_id, binding.device_id, 'device.offline', this.db.now(), null, null, { last_seen_at: state.last_seen_at });
        if (state.data_freshness === 'stale' || (state.data_freshness === 'missing' && this.db.clock().getTime() - Date.parse(binding.bound_at) > (await deviceTiming(this.db, binding.device_id)).fresh_seconds * 1000)) await this.emitSafety(binding.pet_id, binding.device_id, 'location.stale', this.db.now(), state.last_location_id, null,
          { last_location_at: state.last_location_at, message: '无法确认当前位置' });
      }
    });
  }
  async latest(user: string, petId: string) {
    await this.db.pet(user, petId);
    return await latestLocation(this.db, petId);
  }
  async locations(user: string, petId: string, raw: unknown) {
    await this.db.pet(user, petId);
    const query = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional() }).parse(raw);
    const range = boundedRange(query.from, query.to, this.db.clock());
    const cursor = query.cursor ? (await this.db.get('SELECT * FROM locations WHERE id=? AND pet_id=?', query.cursor, petId)) : null;
    if (query.cursor && !cursor) fail(400, 'INVALID_CURSOR', '分页游标不正确');
    const rows = (await this.db.all(`SELECT l.*,e.binding_id FROM locations l LEFT JOIN device_events e ON e.event_id=l.event_id
      WHERE l.pet_id=? AND (? IS NULL OR l.device_ts>=?) AND (? IS NULL OR l.device_ts<?)
      AND (? IS NULL OR l.device_ts<? OR (l.device_ts=? AND l.id<?)) ORDER BY l.device_ts DESC,l.id DESC LIMIT ?`,
      petId, range.from, range.from, range.to, range.to,
      cursor?.id ?? null, cursor?.device_ts ?? null, cursor?.device_ts ?? null, cursor?.id ?? null, query.limit + 1));
    const presenters = new Map<string, ReturnType<typeof locationPresenter>>();
    const items = await Promise.all(rows.slice(0, query.limit).map(async row => {
      const key = `${row.device_id}:${row.pet_id}`;
      let presenter = presenters.get(key);
      if (!presenter) {
        presenter = locationPresenter(this.db, row.device_id, row.pet_id);
        presenters.set(key, presenter);
      }
      return (await presenter)(row);
    }));
    return { items, next_cursor: rows.length > query.limit ? rows[query.limit - 1].id : null, range };
  }
  async safety(user: string, petId: string, raw: unknown) {
    await this.db.pet(user, petId);
    const query = pageQuery.parse(raw);
    const cursor = query.cursor ? (await this.db.get('SELECT * FROM safety_events WHERE id=? AND pet_id=?', query.cursor, petId)) : null;
    if (query.cursor && !cursor) fail(400, 'INVALID_CURSOR', '分页游标不正确');
    const rows = (await this.db.all(`SELECT * FROM safety_events WHERE pet_id=? AND (? IS NULL OR occurred_at<? OR (occurred_at=? AND id<?)) ORDER BY occurred_at DESC,id DESC LIMIT ?`,
      petId, cursor?.id ?? null, cursor?.occurred_at ?? null, cursor?.occurred_at ?? null, cursor?.id ?? null, query.limit + 1));
    return { items: rows.slice(0, query.limit).map(({ details_json, ...r }) => ({ ...r, details: JSON.parse(details_json) })), next_cursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
  }
}

@ApiTags('telemetry')
@Controller()
export class TelemetryController {
  constructor(@Inject(TelemetryService) readonly telemetry: TelemetryService) {}
  @Public() @Post('ingest/events') @HttpCode(202) @JsonBody(envelopeSchema)
  @ApiHeader({ name: 'x-device-token', required: true })
  async ingest(@Body() body: unknown, @Headers('x-device-token') token?: string) {
    if (!token) fail(401, 'DEVICE_UNAUTHENTICATED', '需要设备身份令牌');
    return await this.telemetry.ingest(body, token);
  }
  @ApiBearerAuth() @Get('ingest/events/:id') async event(@CurrentUser() user: string, @Param('id') id: string) { return await this.telemetry.event(user, id); }
  @ApiBearerAuth() @Get('pets/:id/location/latest') async latest(@CurrentUser() user: string, @Param('id') id: string) { return await this.telemetry.latest(user, id); }
  @ApiBearerAuth() @Get('pets/:id/locations') async locations(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return await this.telemetry.locations(user, id, query); }
  @ApiBearerAuth() @Get('pets/:id/safety-events') async safety(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return await this.telemetry.safety(user, id, query); }
}
