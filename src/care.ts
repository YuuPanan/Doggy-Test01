import { Body, Controller, Get, Header, Headers, Inject, Injectable, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, dateTime, fail, JsonBody, pageQuery } from './http';
import { presentPet, timezoneForPet } from './identity';
import { latestLocation } from './location-quality';
import { credentialMetadata, DevicesService } from './devices';
import { FencesService } from './fences';

const careType = z.enum(['weight', 'feeding', 'medication', 'grooming', 'note', 'toileting', 'custom']);
const customType = z.string().trim().min(1).max(100);
const valueSchema = z.record(z.string(), z.json());
const createSchema = z.object({
  pet_id: z.string().min(1), type: careType, value: valueSchema,
  recorded_at: dateTime, source: z.enum(['owner', 'vet']).default('owner'), notes: z.string().max(4000).default(''),
  custom_type: customType.optional(),
});
const updateSchema = z.object({ value: valueSchema.optional(), recorded_at: dateTime.optional(), notes: z.string().max(4000).optional(), custom_type: customType.optional() });
const withdrawSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const attachmentBody = z.object({ filename: z.string().trim().min(1).max(255).optional() });
const attachmentColumns = 'id,record_id,filename,content_type,size_bytes,sha256,created_by,created_at';
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
export const MAX_CARE_ATTACHMENTS = 10;
export type CareUpload = { originalname: string; mimetype: string; buffer: Buffer };
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '日期不存在');
const periodSchema = z.object({ date: calendarDate.optional(), timezone: z.string().optional() });
const listSchema = pageQuery.extend({ from: dateTime.optional(), to: dateTime.optional(), type: careType.optional(), custom_type: customType.optional(), status: z.enum(['active', 'withdrawn', 'all']).default('active') });
const feedbackSchema = z.object({
  feature_date: calendarDate, assessment: z.enum(['helpful', 'incorrect', 'other']),
  comment: z.string().min(1).max(4000), evidence: valueSchema.default({}),
});

function localDate(instant: Date, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(instant);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function shiftedDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
// Search the local date boundary rather than assuming every day contains 24 hours.
function dayBoundary(date: string, formatter: Intl.DateTimeFormat) {
  const center = Date.parse(`${date}T00:00:00Z`) / 1000;
  let low = center - 36 * 3600, high = center + 36 * 3600;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(new Date(middle * 1000), formatter) < date) low = middle + 1;
    else high = middle;
  }
  return new Date(low * 1000);
}
export function activityWindow(date: string | undefined, timezone: string, now: Date) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return fail(400, 'INVALID_TIMEZONE', '时区必须为有效 IANA 时区'); }
  const target = date ?? localDate(now, formatter);
  const start = dayBoundary(target, formatter);
  if (localDate(start, formatter) !== target) fail(400, 'INVALID_DATE', '该时区没有此日期');
  return { date: target, timezone, start: start.toISOString(), end: dayBoundary(shiftedDate(target, 1), formatter).toISOString() };
}
function attachmentMetadata(row: Row): Row {
  return { ...row, download_path: `/api/v1/care-attachments/${row.id}/content` };
}
async function presentRecord(db: Db, row: Row): Promise<Row> {
  const { value_json, ...rest } = row;
  const attachments = (await db.all(`SELECT ${attachmentColumns} FROM care_attachments WHERE record_id=? ORDER BY created_at,id`, row.id)).map(attachmentMetadata);
  return { ...rest, value: JSON.parse(value_json), attachments };
}
function checkCare(type: string, value: Record<string, unknown> | undefined, name?: string | null) {
  if (value && type === 'weight') z.object({ weight_kg: z.number().positive().max(300) }).parse(value);
  if (value && type === 'toileting') z.object({ kind: z.enum(['urination', 'defecation', 'both']) }).parse(value);
  if (type === 'custom') z.object({ custom_type: customType }).parse({ custom_type: name });
  else if (name != null) fail(400, 'CUSTOM_TYPE_NOT_APPLICABLE', '只有自定义照护记录可以设置 custom_type');
}
async function refreshCareWeight(db: Db, petId: string, updatedAt = db.now()) {
  const latest = await db.get("SELECT value_json FROM care_records WHERE pet_id=? AND type='weight' AND withdrawn_at IS NULL ORDER BY recorded_at DESC,created_at DESC,id DESC LIMIT 1", petId);
  // shortcut: overwritten profile weights have no history; add provenance before restoring a manual baseline.
  await db.run('UPDATE pets SET weight_kg=?,updated_at=? WHERE id=?', latest ? JSON.parse(latest.value_json).weight_kg : null, updatedAt, petId);
}
export async function withdrawCareRecord(db: Db, id: string, at: string, actor: string | null, reason: string) {
  const row = await db.get('SELECT * FROM care_records WHERE id=?', id);
  if (!row) return undefined;
  if (row.withdrawn_at) return presentRecord(db, row);
  if (actor) await db.run('INSERT INTO care_record_revisions VALUES (?,?,?,?,?)', db.id(), id, JSON.stringify(await presentRecord(db, row)), actor, at);
  await db.run('UPDATE care_records SET withdrawn_at=?,withdrawn_by=?,withdrawal_reason=?,updated_at=? WHERE id=?', at, actor, reason, at, id);
  if (row.type === 'weight') await refreshCareWeight(db, row.pet_id, at);
  await db.audit(actor, actor ? 'care.withdrawn' : 'care.withdrawal_replayed', id, { pet_id: row.pet_id, type: row.type });
  return presentRecord(db, (await db.get('SELECT * FROM care_records WHERE id=?', id))!);
}
function coveredSeconds(intervals: [number, number][]) {
  let covered = 0, previousEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of intervals) {
    covered += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return covered / 1000;
}

@Injectable()
export class CareService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async create(user: string, raw: unknown, key?: string) {
    const input = createSchema.parse(raw);
    checkCare(input.type, input.value, input.custom_type);
    return this.db.transaction(async () => {
      await this.db.pet(user, input.pet_id, true);
      return this.db.idempotent(user, 'POST /care-records', key, input, async () => {
        const id = this.db.id(), now = this.db.now();
        await this.db.run('INSERT INTO care_records(id,pet_id,type,value_json,recorded_at,source,notes,created_by,created_at,updated_at,custom_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, input.pet_id, input.type, JSON.stringify(input.value), input.recorded_at, input.source, input.notes, user, now, now, input.custom_type ?? null);
        if (input.type === 'weight') await refreshCareWeight(this.db, input.pet_id);
        await this.db.audit(user, 'care.created', id, { pet_id: input.pet_id });
        return presentRecord(this.db, (await this.db.get('SELECT * FROM care_records WHERE id=?', id))!);
      });
    });
  }
  async get(user: string, id: string) {
    const row = await this.db.get('SELECT * FROM care_records WHERE id=?', id);
    if (!row) fail(404, 'NOT_FOUND', '照护记录不存在');
    await this.db.pet(user, row.pet_id);
    return presentRecord(this.db, row);
  }
  async uploadAttachment(user: string, id: string, raw: unknown, file: CareUpload | undefined, key?: string) {
    const input = attachmentBody.parse(raw ?? {});
    if (!file) fail(400, 'ATTACHMENT_REQUIRED', '请选择附件文件');
    const bytes = file.buffer, contentType = file.mimetype.toLowerCase();
    if (!bytes.length) fail(400, 'EMPTY_ATTACHMENT', '附件不能为空');
    if (bytes.length > MAX_ATTACHMENT_SIZE) fail(413, 'ATTACHMENT_TOO_LARGE', '附件最多为5MiB');
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType)) fail(415, 'UNSUPPORTED_ATTACHMENT_TYPE', '附件支持JPEG、PNG、WebP和PDF');
    const starts = (prefix: Buffer) => bytes.subarray(0, prefix.length).equals(prefix);
    const valid = contentType === 'image/jpeg' ? starts(Buffer.from([255, 216, 255]))
      : contentType === 'image/png' ? starts(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : contentType === 'image/webp' ? starts(Buffer.from('RIFF')) && bytes.subarray(8, 12).toString() === 'WEBP'
      : starts(Buffer.from('%PDF-'));
    if (!valid) fail(400, 'INVALID_ATTACHMENT_CONTENT', '文件内容与附件类型不符');
    const originalBytes = Buffer.from(file.originalname, 'latin1');
    const originalName = /^[\u0000-\u00ff]*$/u.test(file.originalname) && isUtf8(originalBytes) ? originalBytes.toString('utf8') : file.originalname;
    const filename = z.string().trim().min(1).max(255).parse(input.filename ?? originalName);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.db.transaction(async () => {
      const current = await this.get(user, id);
      await this.db.pet(user, current.pet_id, true);
      if (current.withdrawn_at) fail(409, 'CARE_RECORD_WITHDRAWN', '已撤回的照护记录不能新增附件');
      return this.db.idempotent(user, `POST /care-records/${id}/attachments`, key, { filename, content_type: contentType, size_bytes: bytes.length, sha256 }, async () => {
        if (current.attachments.length >= MAX_CARE_ATTACHMENTS) fail(409, 'ATTACHMENT_LIMIT_REACHED', '每条照护记录最多10个附件');
        const attachmentId = this.db.id(), now = this.db.now();
        await this.db.run('INSERT INTO care_record_revisions VALUES (?,?,?,?,?)', this.db.id(), id, JSON.stringify(current), user, now);
        await this.db.run('INSERT INTO care_attachments(id,record_id,filename,content_type,size_bytes,sha256,content_base64,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          attachmentId, id, filename, contentType, bytes.length, sha256, bytes.toString('base64'), user, now);
        await this.db.run('UPDATE care_records SET updated_at=? WHERE id=?', now, id);
        await this.db.audit(user, 'care.attachment_added', attachmentId, { record_id: id, pet_id: current.pet_id });
        return attachmentMetadata((await this.db.get(`SELECT ${attachmentColumns} FROM care_attachments WHERE id=?`, attachmentId))!);
      });
    });
  }
  async attachments(user: string, id: string) {
    return { items: (await this.get(user, id)).attachments };
  }
  async attachmentContent(user: string, id: string): Promise<Row> {
    return this.db.transaction(async () => {
      const row = await this.db.get(`SELECT ${attachmentColumns},content_base64 FROM care_attachments WHERE id=?`, id);
      if (!row) fail(404, 'NOT_FOUND', '附件不存在');
      await this.get(user, row.record_id);
      const { content_base64, ...metadata } = row;
      return { ...attachmentMetadata(metadata), buffer: Buffer.from(content_base64, 'base64') };
    });
  }
  async update(user: string, id: string, raw: unknown, key?: string) {
    const input = updateSchema.parse(raw);
    return await this.db.transaction(async () => {
      const row = await this.db.get('SELECT * FROM care_records WHERE id=?', id);
      if (!row) fail(404, 'NOT_FOUND', '照护记录不存在');
      await this.db.pet(user, row.pet_id, true);
      if (row.withdrawn_at) fail(409, 'CARE_RECORD_WITHDRAWN', '已撤回的照护记录不能编辑');
      checkCare(row.type, input.value, input.custom_type ?? row.custom_type);
      return this.db.idempotent(user, `PATCH /care-records/${id}`, key, input, async () => {
        await this.db.run('INSERT INTO care_record_revisions VALUES (?,?,?,?,?)', this.db.id(), id, JSON.stringify(await presentRecord(this.db, row)), user, this.db.now());
        await this.db.run('UPDATE care_records SET value_json=?,recorded_at=?,notes=?,custom_type=?,updated_at=? WHERE id=?',
          input.value === undefined ? row.value_json : JSON.stringify(input.value), input.recorded_at ?? row.recorded_at,
          input.notes ?? row.notes, input.custom_type ?? row.custom_type, this.db.now(), id);
        if (row.type === 'weight') await refreshCareWeight(this.db, row.pet_id);
        await this.db.audit(user, 'care.updated', id, { pet_id: row.pet_id });
        return presentRecord(this.db, (await this.db.get('SELECT * FROM care_records WHERE id=?', id))!);
      });
    });
  }
  async withdraw(user: string, id: string, raw: unknown, key?: string) {
    const input = withdrawSchema.parse(raw);
    return this.db.transaction(async () => {
      const row = await this.db.get('SELECT * FROM care_records WHERE id=?', id);
      if (!row) fail(404, 'NOT_FOUND', '照护记录不存在');
      const pet = await this.db.pet(user, row.pet_id, true);
      if (row.created_by !== user && (await this.db.household(user, pet.household_id)).role !== 'owner') {
        fail(403, 'CARE_AUTHOR_OR_OWNER_REQUIRED', '只有当前可写的记录作者或家庭所有者可以撤回');
      }
      return this.db.idempotent(user, `POST /care-records/${id}/withdraw`, key, input, async () => {
        if (row.withdrawn_at) {
          if (row.withdrawal_reason !== input.reason) fail(409, 'CARE_RECORD_ALREADY_WITHDRAWN', '照护记录已按其他理由撤回');
          return presentRecord(this.db, row);
        }
        const receipt = await this.db.recordDeletion('care_withdrawal', id);
        return (await withdrawCareRecord(this.db, id, receipt.deleted_at, user, input.reason))!;
      });
    });
  }
  async list(user: string, petId: string, raw: unknown) {
    await this.db.pet(user, petId);
    const query = listSchema.parse(raw);
    if (query.from && query.to && query.from > query.to) fail(400, 'INVALID_RANGE', 'from 不能晚于 to');
    const cursor = query.cursor ? (await this.db.get('SELECT id,recorded_at FROM care_records WHERE id=? AND pet_id=?', query.cursor, petId)) : undefined;
    if (query.cursor && !cursor) fail(400, 'INVALID_CURSOR', '分页游标不存在');
    const rows = await this.db.all(`SELECT * FROM care_records WHERE pet_id=?
      AND (? IS NULL OR recorded_at>=?) AND (? IS NULL OR recorded_at<?) AND (? IS NULL OR type=?)
      AND (? IS NULL OR custom_type=?)
      AND (?='all' OR (?='active' AND withdrawn_at IS NULL) OR (?='withdrawn' AND withdrawn_at IS NOT NULL))
      AND (? IS NULL OR (recorded_at,id)<(?,?)) ORDER BY recorded_at DESC,id DESC LIMIT ?`,
      petId, query.from ?? null, query.from ?? null, query.to ?? null, query.to ?? null, query.type ?? null, query.type ?? null,
      query.custom_type ?? null, query.custom_type ?? null,
      query.status, query.status, query.status,
      cursor?.id ?? null, cursor?.recorded_at ?? null, cursor?.id ?? null, query.limit + 1);
    return { items: await Promise.all(rows.slice(0, query.limit).map(row => presentRecord(this.db, row))), next_cursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
  }
  async history(user: string, id: string) {
    const row = await this.db.get('SELECT * FROM care_records WHERE id=?', id);
    if (!row) fail(404, 'NOT_FOUND', '照护记录不存在');
    await this.db.pet(user, row.pet_id);
    return {
      current: await presentRecord(this.db, row),
      revisions: (await this.db.all('SELECT * FROM care_record_revisions WHERE record_id=? ORDER BY changed_at,id', id))
        .map(({ snapshot_json, ...revision }): Row => ({ ...revision, record: JSON.parse(snapshot_json) })),
    };
  }
  async daily(user: string, petId: string, raw: unknown) {
    await this.db.pet(user, petId);
    const query = periodSchema.parse(raw);
    return await this.summary(petId, activityWindow(query.date, (await timezoneForPet(this.db, petId, query.timezone)), this.db.clock()));
  }
  async interval(user: string, petId: string, window: ReturnType<typeof activityWindow>): Promise<Row> {
    await this.db.pet(user, petId);
    const revision = (await this.db.get('SELECT revision FROM activity_versions WHERE pet_id=?', petId))?.revision ?? 0;
    return { ...(await this.calculateSummary(petId, window)), aggregation_version: 'interval-v1', source_revision: revision, generated_at: this.db.now() };
  }
  private async summary(petId: string, window: ReturnType<typeof activityWindow>): Promise<Row> {
    return await this.db.transaction(async () => {
      const revision = (await this.db.get('SELECT revision FROM activity_versions WHERE pet_id=?', petId))?.revision ?? 0;
      const cached = await this.db.get('SELECT * FROM daily_summaries WHERE pet_id=? AND local_date=? AND timezone=?', petId, window.date, window.timezone);
      if (cached?.aggregation_version === 'daily-v2' && cached.source_revision === revision) return JSON.parse(cached.summary_json);
      const summary = { ...(await this.calculateSummary(petId, window)), aggregation_version: 'daily-v2', source_revision: revision, generated_at: this.db.now() };
      await this.db.run(`INSERT INTO daily_summaries VALUES (?,?,?,?,?,?,?) ON CONFLICT(pet_id,local_date,timezone) DO UPDATE SET
        aggregation_version=excluded.aggregation_version,source_revision=excluded.source_revision,
        generated_at=excluded.generated_at,summary_json=excluded.summary_json`,
        petId, window.date, window.timezone, summary.aggregation_version, revision, summary.generated_at, JSON.stringify(summary));
      return summary;
    });
  }
  private async calculateSummary(petId: string, window: ReturnType<typeof activityWindow>) {
    const samples = window.start === window.end ? [] : await this.db.all('SELECT * FROM activity_samples WHERE pet_id=? AND start_at<? AND end_at>? ORDER BY start_at', petId, window.end, window.start);
    const totals: Record<string, number | null> = { steps: null, active_seconds: null, distance_m: null, sleep_seconds: null };
    const metricSamples: Record<string, number> = { steps: 0, active_seconds: 0, distance_m: 0, sleep_seconds: 0 };
    const metricIntervals: Record<string, [number, number][]> = { steps: [], active_seconds: [], distance_m: [], sleep_seconds: [] };
    const intervals: [number, number][] = [];
    let estimated = false;
    for (const sample of samples) {
      const start = Date.parse(sample.start_at), end = Date.parse(sample.end_at);
      const clippedStart = Math.max(start, Date.parse(window.start)), clippedEnd = Math.min(end, Date.parse(window.end));
      // shortcut: split samples assume uniform activity; use finer samples when firmware supplies them.
      const fraction = (clippedEnd - clippedStart) / (end - start);
      intervals.push([clippedStart, clippedEnd]);
      estimated ||= Boolean(sample.estimated) || fraction < 1;
      for (const metric of Object.keys(totals)) if (sample[metric] !== null) {
        totals[metric] = (totals[metric] ?? 0) + sample[metric] * fraction;
        metricSamples[metric]++;
        metricIntervals[metric].push([clippedStart, clippedEnd]);
      }
    }
    const covered = coveredSeconds(intervals);
    const rounded = (value: number | null, divisor = 1) => value === null ? null : Math.round(value / divisor * 100) / 100;
    return {
      pet_id: petId, local_date: window.date, timezone: window.timezone, period_start: window.start, period_end: window.end,
      sample_count: samples.length, coverage_seconds: covered,
      data_status: !samples.length ? 'missing' : covered * 1000 < Date.parse(window.end) - Date.parse(window.start) ? 'partial' : 'available',
      steps: rounded(totals.steps), active_minutes: rounded(totals.active_seconds, 60),
      distance_m: rounded(totals.distance_m), sleep_minutes: rounded(totals.sleep_seconds, 60),
      metric_sample_counts: metricSamples, metric_coverage_seconds: Object.fromEntries(Object.entries(metricIntervals).map(([metric, spans]) => [metric, coveredSeconds(spans)])), estimated,
      sources: [...new Set(samples.map(sample => sample.source))],
      allocation_method: 'interval_overlap_proportion',
    };
  }
  async weekly(user: string, petId: string, raw: unknown) {
    await this.db.pet(user, petId);
    const query = periodSchema.parse(raw);
    const timezone = await timezoneForPet(this.db, petId, query.timezone);
    const ending = activityWindow(query.date, timezone, this.db.clock());
    const days = await Promise.all(Array.from({ length: 7 }, async (_, i) => await this.summary(petId, activityWindow(shiftedDate(ending.date, i - 6), timezone, this.db.clock()))));
    return { pet_id: petId, timezone, from_date: days[0].local_date, to_date: ending.date, days };
  }
  async overview(user: string, petId: string, raw: unknown) {
    return this.db.transaction(async () => {
      const pet = await presentPet(this.db, (await this.db.pet(user, petId)));
      const activity = await this.daily(user, petId, raw);
      const device = await this.db.get(`SELECT d.id,d.serial_no,d.vendor,d.model,d.created_at,d.owner_user_id,d.credential_version,d.credential_status,d.credential_changed_at,
        s.last_seen_at,s.reported_at,s.battery_pct,s.signal_json,s.firmware_version
        FROM device_bindings b JOIN devices d ON d.id=b.device_id LEFT JOIN device_state s ON s.device_id=d.id
        WHERE b.pet_id=? AND b.unbound_at IS NULL`, petId);
      const deviceState: Row | null = device ? { id: device.id, serial_no: device.serial_no, vendor: device.vendor, model: device.model, is_owner: device.owner_user_id === user, credential: credentialMetadata(device),
        ...(await new DevicesService(this.db).status(device.id)) } : null;
      const location = await latestLocation(this.db, petId), geofences = await new FencesService(this.db).list(user, petId);
      const enabledFences = geofences.items.filter(fence => fence.enabled);
      const safetyEvents = await this.db.all('SELECT * FROM safety_events WHERE pet_id=? ORDER BY occurred_at DESC,id DESC LIMIT 10', petId);
      const openEvents = (await this.db.get(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN a.event_id IS NULL THEN 1 ELSE 0 END),0) AS unacknowledged
        FROM safety_events e LEFT JOIN safety_acknowledgements a ON a.event_id=e.id WHERE e.pet_id=? AND e.status='open'`, petId))!;
      const unacknowledged = await this.db.all(`SELECT e.id,e.type,e.status,e.occurred_at FROM safety_events e
        LEFT JOIN safety_acknowledgements a ON a.event_id=e.id WHERE e.pet_id=? AND e.status='open' AND a.event_id IS NULL
        ORDER BY e.occurred_at DESC,e.id DESC LIMIT 5`, petId);
      const unread = (await this.db.get(`SELECT COUNT(*) AS total FROM notifications n JOIN safety_events e ON e.id=n.event_id
        WHERE e.pet_id=? AND n.user_id=? AND n.read_at IS NULL`, petId, user))!;
      const unreadItems = await this.db.all(`SELECT n.id,n.event_id,n.status,n.created_at,e.type,e.occurred_at
        FROM notifications n JOIN safety_events e ON e.id=n.event_id WHERE e.pet_id=? AND n.user_id=? AND n.read_at IS NULL
        ORDER BY n.created_at DESC,n.id DESC LIMIT 5`, petId, user);
      const currentGaps: string[] = [];
      if (!deviceState) currentGaps.push('device_unbound');
      else if (deviceState.connection_status === 'unknown') currentGaps.push('device_status_unknown');
      else if (deviceState.connection_status === 'offline') currentGaps.push('device_offline');
      if (!location) currentGaps.push('location_missing');
      else if (!location.usable_for_tracking) currentGaps.push('location_unusable');
      if (!enabledFences.length) currentGaps.push('geofence_unconfigured');
      else if (enabledFences.some(fence => fence.state.effective_status === 'unknown')) currentGaps.push('geofence_state_unknown');
      if (deviceState?.reporting.status === 'unconfigured') currentGaps.push('reporting_unconfigured');
      return {
        pet, activity, device: deviceState, location,
        care_records: (await this.list(user, petId, { from: activity.period_start, to: activity.period_end, limit: 10 })).items,
        safety_events: safetyEvents.map(({ details_json, ...event }) => ({ ...event, details: JSON.parse(details_json) })),
        current_state_at: this.db.now(), geofences,
        attention: { open_event_count: openEvents.total, unacknowledged_open_event_count: openEvents.unacknowledged,
          unacknowledged_open_events: unacknowledged, unread_notification_count: unread.total, unread_notifications: unreadItems },
        data_gaps: { activity_period: activity.data_status === 'missing' ? ['activity_missing'] : activity.data_status === 'partial' ? ['activity_partial'] : [], current_state: currentGaps },
      };
    });
  }
  async features(user: string, petId: string, raw: unknown) {
    const daily = await this.daily(user, petId, raw);
    const events = await this.db.all('SELECT id,type,occurred_at FROM safety_events WHERE pet_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at', petId, daily.period_start, daily.period_end);
    return { pet_id: petId, schema_version: '1.0', local_date: daily.local_date, timezone: daily.timezone,
      evidence: [{ source: 'activity_samples', summary: daily }, { source: 'safety_events', events }],
      missing_context: ['佩戴情况', '环境与日常安排', '个体长期基线'], model_output: null };
  }
  async feedback(user: string, petId: string, raw: unknown) {
    const input = feedbackSchema.parse(raw), id = this.db.id();
    return this.db.transaction(async () => {
      await this.db.pet(user, petId, true);
      await this.db.run('INSERT INTO behavior_feedback VALUES (?,?,?,?,?,?,?,?)', id, petId, input.feature_date, input.assessment, input.comment, JSON.stringify(input.evidence), user, this.db.now());
      return { id, pet_id: petId, ...input, created_by: user, created_at: this.db.now() };
    });
  }
}

@ApiTags('照护与活动')
@ApiBearerAuth()
@Controller()
export class CareController {
  constructor(@Inject(CareService) private readonly service: CareService) {}
  @Get('pets/:id/care-records') @ApiQuery({ name: 'type', required: false, enum: careType.options })
  @ApiQuery({ name: 'custom_type', required: false, description: '自定义照护类型名称，精确匹配' })
  list(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.service.list(user, id, query); }
  @Post('care-records') @JsonBody(createSchema) @ApiHeader({ name: 'Idempotency-Key', required: false })
  create(@CurrentUser() user: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.service.create(user, body, key); }
  @Get('care-records/:id') get(@CurrentUser() user: string, @Param('id') id: string) { return this.service.get(user, id); }
  @Patch('care-records/:id') @JsonBody(updateSchema) @ApiHeader({ name: 'Idempotency-Key', required: false })
  update(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.service.update(user, id, body, key); }
  @Post('care-records/:id/withdraw') @JsonBody(withdrawSchema) @ApiHeader({ name: 'Idempotency-Key', required: false })
  withdraw(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.service.withdraw(user, id, body, key); }
  @Get('care-records/:id/history') history(@CurrentUser() user: string, @Param('id') id: string) { return this.service.history(user, id); }
  @Get('pets/:id/activity/daily') daily(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.service.daily(user, id, query); }
  @Get('pets/:id/activity/weekly') weekly(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.service.weekly(user, id, query); }
  @Get('pets/:id/overview') overview(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.service.overview(user, id, query); }
  @Get('pets/:id/features') features(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.service.features(user, id, query); }
  @Post('pets/:id/feedback') @JsonBody(feedbackSchema) feedback(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.service.feedback(user, id, body); }
}

@ApiTags('care-attachments') @ApiBearerAuth() @Controller()
export class CareAttachmentsController {
  constructor(@Inject(CareService) private readonly service: CareService) {}
  @Post('care-records/:id/attachments') @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: {
    file: { type: 'string', format: 'binary' }, filename: { type: 'string', minLength: 1, maxLength: 255 }
  } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_SIZE, files: 1, fields: 1 } }))
  upload(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @UploadedFile() file: CareUpload | undefined, @Headers('idempotency-key') key?: string) {
    return this.service.uploadAttachment(user, id, body, file, key);
  }
  @Get('care-records/:id/attachments')
  list(@CurrentUser() user: string, @Param('id') id: string) { return this.service.attachments(user, id); }
  @Get('care-attachments/:id/content') @Header('Cache-Control', 'no-store')
  async content(@CurrentUser() user: string, @Param('id') id: string) {
    const file = await this.service.attachmentContent(user, id);
    const encodedName = encodeURIComponent(file.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return new StreamableFile(file.buffer, { type: file.content_type, length: file.size_bytes, disposition: `attachment; filename*=UTF-8''${encodedName}` });
  }
}
