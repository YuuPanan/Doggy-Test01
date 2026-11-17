import { Body, Controller, Delete, Get, Header, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { DevicesService } from './devices';
import { CurrentUser, fail, JsonBody, pageQuery } from './http';

const ticketBody = z.object({
  device_id: z.uuid(), category: z.enum(['location', 'notification', 'binding', 'battery', 'wearing', 'other']),
  description: z.string().trim().min(1).max(4000), diagnostics_consent: z.boolean().default(false)
});
const status = z.enum(['open', 'in_progress', 'resolved']);
const ticketQuery = pageQuery.extend({ status: status.optional() });
const updateBody = z.object({ status: z.enum(['in_progress', 'resolved']), reply: z.string().trim().max(4000).default('') });
const safeError = (value: string | null) => value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'UNSPECIFIED_FAILURE';
function p95(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.95) - 1];
}

export class SupportService {
  constructor(@Inject(Db) readonly db: Db) {}

  private async staff(user: string) {
    const allowed = (process.env.SUPPORT_ADMIN_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (!allowed.includes(user) || !(await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', user))) fail(403, 'SUPPORT_STAFF_REQUIRED', '仅已配置的客服账号可执行此操作');
  }
  private async own(user: string, id: string) {
    const ticket = await this.db.get('SELECT * FROM support_tickets WHERE id=? AND created_by=?', id, user);
    if (!ticket) fail(404, 'NOT_FOUND', '工单不存在');
    return ticket;
  }
  private async activeConsent(ticket: Row) {
    if (!ticket.diagnostics_consented_at || ticket.diagnostics_revoked_at || ticket.diagnostics_expires_at <= this.db.now() || !ticket.diagnostics_json) return false;
    return Boolean((await this.db.get(`SELECT b.id FROM device_bindings b JOIN pets p ON p.id=b.pet_id
      JOIN household_members m ON m.household_id=p.household_id AND m.user_id=?
      WHERE b.id=? AND b.device_id=? AND b.pet_id=? AND b.unbound_at IS NULL`,
      ticket.created_by, ticket.binding_id, ticket.device_id, ticket.pet_id)));
  }
  private async present(ticket: Row): Promise<Row> {
    const { binding_id, diagnostics_json, diagnostics_consented_at, diagnostics_expires_at, diagnostics_revoked_at, ...rest } = ticket;
    return { ...rest, diagnostics: { consented_at: diagnostics_consented_at, expires_at: diagnostics_expires_at,
      revoked_at: diagnostics_revoked_at, available: await this.activeConsent(ticket) } };
  }
  private async history(ticketId: string) {
    return (await this.db.all('SELECT id,actor_id,status,reply,created_at FROM support_ticket_history WHERE ticket_id=? ORDER BY created_at,rowid', ticketId)).map(row => ({ ...row }));
  }
  private async snapshot(deviceId: string, binding: Row) {
    const device = (await this.db.get('SELECT id,serial_no,vendor,model,hardware_rev FROM devices WHERE id=?', deviceId))!;
    const state = await new DevicesService(this.db).status(deviceId);
    const start = new Date(this.db.clock().getTime() - 86400_000).toISOString();
    const events = await this.db.all(`SELECT process_status,device_ts,received_at,processing_started_at,processed_at FROM device_events
      WHERE device_id=? AND binding_id=? AND received_at>=? AND received_at<=?`, deviceId, binding.id, start, this.db.now());
    const counts: Record<string, number> = {};
    for (const event of events) counts[event.process_status] = (counts[event.process_status] ?? 0) + 1;
    const delay = (end: string, begin: string) => events.filter(event => event[end] && Date.parse(event[end]) >= Date.parse(event[begin]))
      .map(event => Date.parse(event[end]) - Date.parse(event[begin]));
    const alertStart = start > binding.bound_at ? start : binding.bound_at;
    const alerts = await this.db.all(`SELECT id,type,occurred_at,status,closed_at FROM safety_events WHERE device_id=? AND pet_id=?
      AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at DESC,id DESC LIMIT 20`, deviceId, binding.pet_id, alertStart, this.db.now());
    const notifications = await this.db.all(`SELECT n.status,n.error,COUNT(*) AS count FROM notifications n JOIN safety_events e ON e.id=n.event_id
      WHERE e.device_id=? AND e.pet_id=? AND e.occurred_at>=? AND e.occurred_at<=? GROUP BY n.status,n.error ORDER BY n.status,n.error`,
      deviceId, binding.pet_id, alertStart, this.db.now());
    return {
      schema_version: '1.0', generated_at: this.db.now(), device: { ...device, firmware_version: state.firmware_version },
      state: { battery_pct: state.battery_pct, low_battery: state.low_battery, connection_status: state.connection_status,
        data_freshness: state.data_freshness, last_seen_at: state.last_seen_at, last_location_at: state.last_location_at },
      reporting: { desired: state.reporting.desired, desired_version: state.reporting.desired_version,
        applied: state.reporting.applied, applied_version: state.reporting.applied_version,
        execution_source: state.reporting.execution_source, status: state.reporting.status, timing: state.timing },
      telemetry: { from: start, to: this.db.now(), event_count: events.length, counts_by_status: counts,
        clock_ahead_count: events.filter(event => Date.parse(event.device_ts) > Date.parse(event.received_at) + 60_000).length,
        ingest_delay_p95_ms: p95(delay('received_at', 'device_ts')),
        queue_delay_p95_ms: p95(delay('processing_started_at', 'received_at')),
        processing_delay_p95_ms: p95(delay('processed_at', 'received_at')) },
      recent_alerts: alerts,
      notification_results: notifications.map(row => ({ status: row.status, error: row.error ? safeError(row.error) : null, count: row.count }))
    };
  }
  async create(user: string, raw: unknown, key?: string): Promise<Row> {
    const input = ticketBody.parse(raw);
    return this.db.transaction(async () => {
      const binding = await new DevicesService(this.db).authorized(user, input.device_id);
      return this.db.idempotent(user, 'POST /support/tickets', key, input, async () => {
        const id = this.db.id(), now = this.db.now();
        await this.db.run(`INSERT INTO support_tickets(id,device_id,pet_id,binding_id,created_by,category,description,
          diagnostics_consented_at,diagnostics_expires_at,diagnostics_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, input.device_id, binding.pet_id, binding.id, user, input.category, input.description,
          input.diagnostics_consent ? now : null,
          input.diagnostics_consent ? new Date(this.db.clock().getTime() + 7 * 86400_000).toISOString() : null,
          input.diagnostics_consent ? JSON.stringify((await this.snapshot(input.device_id, binding))) : null, now, now);
        await this.db.run('INSERT INTO support_ticket_history VALUES (?,?,?,?,?,?)', this.db.id(), id, user, 'open', '', now);
        await this.db.audit(user, 'support.created', id, { diagnostics_consent: input.diagnostics_consent });
        return await this.present((await this.db.get('SELECT * FROM support_tickets WHERE id=?', id))!);
      });
    });
  }
  private async page(user: string | null, raw: unknown) {
    const query = ticketQuery.parse(raw);
    const cursor = query.cursor ? (await this.db.get('SELECT id,created_at FROM support_tickets WHERE id=? AND (? IS NULL OR created_by=?)', query.cursor, user, user)) : null;
    if (query.cursor && !cursor) fail(400, 'INVALID_CURSOR', '分页游标不正确');
    const rows = await this.db.all(`SELECT * FROM support_tickets WHERE (? IS NULL OR created_by=?) AND (? IS NULL OR status=?)
      AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
      user, user, query.status ?? null, query.status ?? null, cursor?.id ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.id ?? null, query.limit + 1);
    return { items: await Promise.all(rows.slice(0, query.limit).map(async row => await this.present(row))), next_cursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
  }
  async list(user: string, query: unknown) { return await this.page(user, query); }
  async detail(user: string, id: string): Promise<Row> { return { ...(await this.present((await this.own(user, id)))), history: await this.history(id) }; }
  async revokeConsent(user: string, id: string) {
    await this.own(user, id);
    return await this.db.transaction(async () => {
      const changed = await this.db.run('UPDATE support_tickets SET diagnostics_revoked_at=?,diagnostics_json=NULL,updated_at=? WHERE id=? AND diagnostics_revoked_at IS NULL', this.db.now(), this.db.now(), id);
      if (changed.changes) await this.db.audit(user, 'support.diagnostics_revoked', id);
      return await this.present((await this.own(user, id)));
    });
  }
  async adminList(user: string, query: unknown) {
    await this.staff(user);
    const result = await this.page(null, query);
    await this.db.audit(user, 'support.staff_list', 'support_tickets', { count: result.items.length });
    return result;
  }
  async adminDetail(user: string, id: string): Promise<Row> {
    await this.staff(user);
    const ticket = await this.db.get('SELECT * FROM support_tickets WHERE id=?', id);
    if (!ticket) fail(404, 'NOT_FOUND', '工单不存在');
    await this.db.audit(user, 'support.staff_view', id);
    return { ...(await this.present(ticket)), history: await this.history(id) };
  }
  async update(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    await this.staff(user);
    const input = updateBody.parse(raw);
    return await this.db.idempotent(user, `PATCH /admin/support/tickets/${id}`, key, input, async () => {
      const ticket = await this.db.get('SELECT * FROM support_tickets WHERE id=?', id);
      if (!ticket) fail(404, 'NOT_FOUND', '工单不存在');
      const previous = (await this.db.get('SELECT status,reply FROM support_ticket_history WHERE ticket_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', id))!;
      if (previous.status !== input.status || previous.reply !== input.reply) {
        await this.db.run('UPDATE support_tickets SET status=?,updated_at=? WHERE id=?', input.status, this.db.now(), id);
        await this.db.run('INSERT INTO support_ticket_history VALUES (?,?,?,?,?,?)', this.db.id(), id, user, input.status, input.reply, this.db.now());
        await this.db.audit(user, 'support.status_changed', id, { status: input.status });
      }
      return { ...(await this.present((await this.db.get('SELECT * FROM support_tickets WHERE id=?', id))!)), history: await this.history(id) };
    });
  }
  async diagnostics(user: string, deviceId: string, ticketId: string) {
    return await this.db.transaction(async () => {
      await this.staff(user);
      const ticket = await this.db.get('SELECT * FROM support_tickets WHERE id=? AND device_id=?', z.uuid().parse(ticketId), deviceId);
      if (!ticket || !(await this.activeConsent(ticket))) fail(404, 'DIAGNOSTICS_UNAVAILABLE', '诊断未授权、已到期或已失效');
      await this.db.audit(user, 'support.diagnostics_viewed', ticket.id);
      return { ticket_id: ticket.id, consent_expires_at: ticket.diagnostics_expires_at, snapshot: JSON.parse(ticket.diagnostics_json) };
    });
  }
  async expireDiagnostics() {
    return (await this.db.run('UPDATE support_tickets SET diagnostics_json=NULL WHERE diagnostics_json IS NOT NULL AND diagnostics_expires_at<=?', this.db.now())).changes;
  }
}

@ApiTags('support') @ApiBearerAuth()
@Controller('support/tickets')
export class SupportController {
  constructor(@Inject(SupportService) readonly support: SupportService) {}
  @Post() @JsonBody(ticketBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  create(@CurrentUser() user: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.support.create(user, body, key); }
  @Get() list(@CurrentUser() user: string, @Query() query: unknown) { return this.support.list(user, query); }
  @Get(':id') detail(@CurrentUser() user: string, @Param('id') id: string) { return this.support.detail(user, id); }
  @Delete(':id/diagnostics-consent') revoke(@CurrentUser() user: string, @Param('id') id: string) { return this.support.revokeConsent(user, id); }
}

@ApiTags('support-admin') @ApiBearerAuth()
@Controller('admin')
export class SupportAdminController {
  constructor(@Inject(SupportService) readonly support: SupportService) {}
  @Get('support/tickets') list(@CurrentUser() user: string, @Query() query: unknown) { return this.support.adminList(user, query); }
  @Get('support/tickets/:id') detail(@CurrentUser() user: string, @Param('id') id: string) { return this.support.adminDetail(user, id); }
  @Patch('support/tickets/:id') @JsonBody(updateBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  update(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.support.update(user, id, body, key); }
  @Get('devices/:id/diagnostics') @Header('Cache-Control', 'no-store')
  diagnostics(@CurrentUser() user: string, @Param('id') id: string, @Query('ticket_id') ticket?: string) { return this.support.diagnostics(user, id, z.uuid().parse(ticket)); }
}
