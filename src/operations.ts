import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody, pageQuery } from './http';
import { credentialMetadata, DevicesService } from './devices';
import { presentLocation } from './location-quality';
import { settings } from './config';

const summaryQuery = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) });
const failureQuery = pageQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['dead', 'retry']).optional() });
const retryBody = z.object({ reason: z.string().trim().min(1).max(500) });
const eventFields = 'e.event_id,e.device_id,e.type,e.device_ts,e.received_at,e.process_status,e.attempts,e.next_attempt_at,e.error,e.processing_started_at,e.processed_at';
const eventBinding = `FROM device_events e JOIN device_bindings b ON b.id=e.binding_id AND b.device_id=e.device_id
  AND b.pet_id=e.pet_id AND b.unbound_at IS NULL JOIN pets p ON p.id=b.pet_id`;
const safeError = (value: string | null) => value === null ? null : /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : 'PROCESSING_FAILED';
const counts = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.status, row.count]));

export class OperationsService {
  constructor(@Inject(Db) readonly db: Db) {}

  private async delay(household: string, from: string, to: string, end: 'received_at' | 'processing_started_at' | 'processed_at', start: 'device_ts' | 'received_at') {
    const difference = this.db.driver === 'postgres'
      ? `ROUND(EXTRACT(EPOCH FROM (e.${end}::timestamptz-e.${start}::timestamptz))*1000)`
      : `ROUND((julianday(e.${end})-julianday(e.${start}))*86400000)`;
    return (await this.db.get(`WITH delays AS (
      SELECT ${difference} AS delay_ms ${eventBinding} WHERE p.household_id=? AND e.received_at>=? AND e.received_at<=?
      AND e.${end} IS NOT NULL AND e.${end}>=e.${start}
    ), ranked AS (SELECT delay_ms,ROW_NUMBER() OVER(ORDER BY delay_ms) AS position,COUNT(*) OVER() AS samples FROM delays)
    SELECT COALESCE(MAX(samples),0) AS samples,MAX(CASE WHEN position=(samples*95+99)/100 THEN delay_ms END) AS p95_ms FROM ranked`, household, from, to))!;
  }

  async summary(user: string, household: string, raw: unknown): Promise<Row> {
    await this.db.household(user, household);
    const { hours } = summaryQuery.parse(raw), to = this.db.now(), from = new Date(Date.parse(to) - hours * 3600000).toISOString();
    const bindings = await this.db.all(`SELECT b.id,b.device_id,b.pet_id,p.name AS pet_name,d.serial_no,d.created_at,
      d.credential_version,d.credential_status,d.credential_changed_at FROM device_bindings b
      JOIN pets p ON p.id=b.pet_id JOIN devices d ON d.id=b.device_id WHERE p.household_id=? AND b.unbound_at IS NULL ORDER BY p.id`, household);
    const devices = await Promise.all(bindings.map(async binding => {
      const state = await new DevicesService(this.db).status(binding.device_id);
      const row = await this.db.get(`SELECT l.* FROM device_state s JOIN locations l ON l.id=s.last_location_id
        JOIN device_events e ON e.event_id=l.event_id WHERE s.device_id=? AND l.device_id=? AND l.pet_id=? AND e.binding_id=?`,
      binding.device_id, binding.device_id, binding.pet_id, binding.id);
      const location = row ? await presentLocation(this.db, row) : null;
      return { pet_id: binding.pet_id, pet_name: binding.pet_name, device_id: binding.device_id, serial_no: binding.serial_no, credential: credentialMetadata(binding),
        connection_status: state.connection_status, last_seen_at: state.last_seen_at, battery_pct: state.battery_pct, low_battery: state.low_battery,
        location: { device_ts: location?.device_ts ?? null, age_seconds: location ? (Date.parse(to) - Date.parse(location.device_ts)) / 1000 : null,
          freshness: location?.freshness ?? 'missing', quality_flags: location?.quality_flags ?? [], usable_for_tracking: location?.usable_for_tracking ?? false },
        reporting: { status: state.reporting.status, desired_version: state.reporting.desired_version, applied_version: state.reporting.applied_version } };
    }));
    const queueRows = await this.db.all(`SELECT e.process_status AS status,COUNT(*) AS count,MIN(e.received_at) AS oldest ${eventBinding}
      WHERE p.household_id=? AND e.process_status<>'processed' GROUP BY e.process_status`, household);
    const oldest = queueRows.map(row => row.oldest as string).sort()[0] ?? null;
    const telemetry = await this.db.all(`SELECT e.process_status AS status,COUNT(*) AS count ${eventBinding}
      WHERE p.household_id=? AND e.received_at>=? AND e.received_at<=? GROUP BY e.process_status`, household, from, to);
    const clockAhead = this.db.driver === 'postgres' ? `e.device_ts::timestamptz>e.received_at::timestamptz+INTERVAL '60 seconds'`
      : `julianday(e.device_ts)>julianday(e.received_at)+60.0/86400`;
    const ahead = (await this.db.get(`SELECT COUNT(*) AS count ${eventBinding} WHERE p.household_id=? AND e.received_at>=? AND e.received_at<=? AND ${clockAhead}`, household, from, to))!.count;
    const quality = (await this.db.get(`SELECT COUNT(*) AS received_points,COALESCE(SUM(CASE WHEN l.source='gnss' AND l.accuracy_m<=100 AND l.quality_flags_json='[]' THEN 1 ELSE 0 END),0) AS good_points
      FROM locations l JOIN device_events e ON e.event_id=l.event_id JOIN device_bindings b ON b.id=e.binding_id AND b.unbound_at IS NULL
      AND b.device_id=l.device_id AND b.pet_id=l.pet_id JOIN pets p ON p.id=b.pet_id WHERE p.household_id=? AND l.received_at>=? AND l.received_at<=?`, household, from, to))!;
    const notifications = await this.db.all(`SELECT n.status,COUNT(*) AS count FROM notifications n JOIN safety_events s ON s.id=n.event_id
      JOIN device_bindings b ON b.device_id=s.device_id AND b.pet_id=s.pet_id AND b.unbound_at IS NULL AND s.occurred_at>=b.bound_at
      JOIN pets p ON p.id=b.pet_id WHERE p.household_id=? AND n.user_id=? AND n.created_at>=b.bound_at AND n.created_at>=? AND n.created_at<=? GROUP BY n.status`, household, user, from, to);
    const safety = await this.db.all(`SELECT s.type AS status,COUNT(*) AS count FROM safety_events s JOIN device_bindings b
      ON b.device_id=s.device_id AND b.pet_id=s.pet_id AND b.unbound_at IS NULL AND s.occurred_at>=b.bound_at
      JOIN pets p ON p.id=b.pet_id WHERE p.household_id=? AND s.status='open' GROUP BY s.type`, household);
    const [ingest, waiting, processing] = await Promise.all([
      this.delay(household, from, to, 'received_at', 'device_ts'), this.delay(household, from, to, 'processing_started_at', 'received_at'),
      this.delay(household, from, to, 'processed_at', 'received_at')
    ]);
    await this.db.household(user, household);
    const currentBindings = await this.db.all(`SELECT b.id FROM device_bindings b JOIN pets p ON p.id=b.pet_id
      WHERE p.household_id=? AND b.unbound_at IS NULL ORDER BY p.id`, household);
    if (JSON.stringify(currentBindings.map(b => b.id)) !== JSON.stringify(bindings.map(b => b.id))) fail(409, 'BINDINGS_CHANGED', '设备绑定已变化，请刷新运行简报');
    return { household_id: household, generated_at: to, mode: settings().DATA_MODE, window: { from, to, hours }, devices,
      totals: { devices: devices.length, online: devices.filter(d => d.connection_status === 'online').length,
        offline: devices.filter(d => d.connection_status === 'offline').length, unknown: devices.filter(d => d.connection_status === 'unknown').length,
        low_battery: devices.filter(d => d.low_battery === true).length },
      queue: { pending: 0, retry: 0, dead: 0, ...counts(queueRows), oldest_unprocessed_received_at: oldest,
        oldest_unprocessed_age_seconds: oldest ? (Date.parse(to) - Date.parse(oldest)) / 1000 : null },
      telemetry: { event_count: telemetry.reduce((sum, row) => sum + row.count, 0), counts_by_status: counts(telemetry), clock_ahead_count: ahead,
        ingest_delay: ingest, queue_delay: waiting, processing_delay: processing },
      location_quality: { ...quality, basis: 'projected_locations_received_in_window', good_point_ratio: quality.received_points ? quality.good_points / quality.received_points : null },
      notifications: { scope: 'current_user', counts_by_status: counts(notifications) }, open_safety_events: { counts_by_type: counts(safety) } };
  }

  async failures(user: string, pet: string, raw: unknown): Promise<Row> {
    await this.db.pet(user, pet);
    const input = failureQuery.parse(raw);
    const cursor = input.cursor ? await this.db.get(`SELECT e.event_id,e.received_at ${eventBinding}
      WHERE e.event_id=? AND b.pet_id=?`, input.cursor, pet) : null;
    if (input.cursor && !cursor) fail(400, 'INVALID_CURSOR', '失败记录游标不存在或已不在当前查询范围');
    const rows = await this.db.all(`SELECT ${eventFields} ${eventBinding} WHERE b.pet_id=? AND e.process_status IN ('dead','retry')
      AND (? IS NULL OR e.process_status=?) AND (? IS NULL OR (e.received_at,e.event_id)<(?,?))
      ORDER BY e.received_at DESC,e.event_id DESC LIMIT ?`, pet, input.status ?? null, input.status ?? null,
    cursor?.event_id ?? null, cursor?.received_at ?? null, cursor?.event_id ?? null, input.limit + 1);
    await this.db.pet(user, pet);
    return { items: rows.slice(0, input.limit).map(row => ({ ...row, error: safeError(row.error) })),
      next_cursor: rows.length > input.limit ? rows[input.limit - 1].event_id : null };
  }

  async retry(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = retryBody.parse(raw);
    return this.db.transaction(async () => {
      const event = await this.db.get(`SELECT ${eventFields},b.pet_id ${eventBinding} WHERE e.event_id=?`, id);
      if (!event) fail(404, 'NOT_FOUND', '事件不存在或不属于当前绑定');
      await this.db.pet(user, event.pet_id, true);
      if ((await this.db.get('SELECT envelope_json FROM device_events WHERE event_id=?', id))!.envelope_json === '{}') fail(409, 'EVENT_DATA_EXPIRED', '该事件原文已删除或超过保留期，不能重试');
      return this.db.idempotent(user, `POST /ingest/events/${id}/retry`, key, input, async () => {
        if (!['dead', 'retry'].includes(event.process_status)) fail(409, 'EVENT_NOT_RETRYABLE', '仅失败或死信事件可以手动重试');
        const now = this.db.now();
        await this.db.run(`UPDATE device_events SET process_status='pending',attempts=0,error=NULL,next_attempt_at=?,processing_started_at=NULL,processed_at=NULL WHERE event_id=?`, now, id);
        await this.db.audit(user, 'telemetry.retry', id, { reason: input.reason, previous_status: event.process_status, previous_attempts: event.attempts });
        return { event_id: id, status: 'pending', requeued_at: now };
      });
    });
  }
}

@ApiTags('operations') @ApiBearerAuth() @Controller()
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}
  @Get('households/:id/operations')
  @ApiQuery({ name: 'hours', required: false, schema: { type: 'integer', minimum: 1, maximum: 168, default: 24 } })
  summary(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.operations.summary(user, id, query); }
  @Get('pets/:id/telemetry-failures')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiQuery({ name: 'status', required: false, enum: ['dead', 'retry'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  failures(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.operations.failures(user, id, query); }
  @Post('ingest/events/:id/retry') @HttpCode(202) @JsonBody(retryBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  retry(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.operations.retry(user, id, body, key); }
}
