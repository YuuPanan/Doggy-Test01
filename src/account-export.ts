import { Controller, Get, Header, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, dateTime, fail, pageQuery } from './http';
import { IdentityService } from './identity';
import { credentialMetadata } from './devices';

type Section = { select: string; from: string; scope: string; key: string; time?: string;
  household?: boolean; write?: boolean; json?: Record<string, string>; booleans?: string[]; credential?: boolean };
const deviceColumns = `d.id,d.serial_no,d.vendor,d.model,d.hardware_rev,d.firmware_version,d.owner_user_id,d.created_at,
  d.credential_version,d.credential_status,d.credential_changed_at`;
const sections: Record<string, Section> = {
  profile: { select: 'u.id,u.email,u.created_at', from: 'users u', scope: 'u.id=?', key: 'u.id', time: 'u.created_at' },
  sessions: { select: 's.id,s.created_at,s.expires_at,s.refresh_expires_at', from: 'sessions s', scope: 's.user_id=?', key: 's.id', time: 's.created_at' },
  notification_preferences: { select: 'n.user_id,n.geofence,n.battery,n.offline,n.location', from: 'notification_preferences n', scope: 'n.user_id=?', key: 'n.user_id', booleans: ['geofence','battery','offline','location'] },
  push_token_metadata: { select: 't.id,t.platform,t.created_at', from: 'push_tokens t', scope: 't.user_id=?', key: 't.id', time: 't.created_at' },
  owned_devices: { select: deviceColumns, from: 'devices d', scope: 'd.owner_user_id=?', key: 'd.id', time: 'd.created_at', credential: true },
  support_tickets: { select: `t.id,t.device_id,t.pet_id,t.category,t.description,t.status,t.diagnostics_consented_at,t.diagnostics_expires_at,
    t.diagnostics_revoked_at,t.created_at,t.updated_at`, from: 'support_tickets t', scope: 't.created_by=?', key: 't.id', time: 't.created_at' },
  support_history: { select: 'h.id,h.ticket_id,h.actor_id,h.status,h.reply,h.created_at', from: 'support_ticket_history h JOIN support_tickets t ON t.id=h.ticket_id', scope: 't.created_by=?', key: 'h.id', time: 'h.created_at' },
  notifications: { select: 'n.id,n.event_id,e.pet_id,e.type,n.status,n.retry_count,n.next_attempt_at,n.error,n.created_at,n.sent_at,n.read_at',
    from: `notifications n JOIN safety_events e ON e.id=n.event_id JOIN pets p ON p.id=e.pet_id
      JOIN household_members m ON m.household_id=p.household_id AND m.user_id=n.user_id`, scope: 'n.user_id=?', key: 'n.id', time: 'n.created_at' },
  feedback: { select: 'f.id,f.pet_id,f.feature_date,f.assessment,f.comment,f.evidence_json,f.created_at', from: 'behavior_feedback f', scope: 'f.created_by=?', key: 'f.id', time: 'f.created_at', json: { evidence_json: 'evidence' } },
  audit: { select: 'a.id,a.action,a.resource_id,a.created_at', from: 'audit_logs a', scope: 'a.actor_id=?', key: 'a.id', time: 'a.created_at' },
  households: { select: "h.id,h.name,h.owner_user_id,h.created_at,COALESCE(s.timezone,'Asia/Shanghai') AS timezone", from: 'households h LEFT JOIN household_settings s ON s.household_id=h.id', scope: 'h.id=?', key: 'h.id', time: 'h.created_at', household: true },
  members: { select: 'm.user_id,u.email,m.role,m.created_at', from: 'household_members m JOIN users u ON u.id=m.user_id', scope: 'm.household_id=?', key: 'm.user_id', time: 'm.created_at', household: true },
  pets: { select: `p.id,p.household_id,p.name,p.species,p.breed,p.birth_date,p.weight_kg,p.created_at,p.updated_at,s.timezone,
      COALESCE(s.timezone,h.timezone,'Asia/Shanghai') AS effective_timezone`, from: 'pets p LEFT JOIN pet_settings s ON s.pet_id=p.id LEFT JOIN household_settings h ON h.household_id=p.household_id', scope: 'p.household_id=?', key: 'p.id', time: 'p.created_at', household: true },
  devices: { select: deviceColumns, from: 'devices d JOIN device_bindings b ON b.device_id=d.id AND b.unbound_at IS NULL JOIN pets p ON p.id=b.pet_id', scope: 'p.household_id=?', key: 'd.id', time: 'd.created_at', household: true, credential: true },
  device_bindings: { select: 'b.id,b.device_id,b.pet_id,b.bound_by,b.bound_at,b.unbound_at', from: 'device_bindings b JOIN pets p ON p.id=b.pet_id', scope: 'p.household_id=?', key: 'b.id', time: 'b.bound_at', household: true },
  device_state: { select: 's.device_id,s.last_seen_at,s.reported_at,s.battery_pct,s.firmware_version,s.last_location_id,s.reported_seq,s.reported_boot_id',
    from: 'device_state s JOIN device_bindings b ON b.device_id=s.device_id AND b.unbound_at IS NULL JOIN pets p ON p.id=b.pet_id', scope: 'p.household_id=?', key: 's.device_id', household: true },
  device_events: { select: 'e.event_id,e.device_id,e.pet_id,e.binding_id,e.type,e.device_ts,e.received_at,e.seq,e.boot_id,e.process_status,e.attempts,e.next_attempt_at,e.error,e.processing_started_at,e.processed_at',
    from: 'device_events e JOIN pets p ON p.id=e.pet_id', scope: 'p.household_id=?', key: 'e.event_id', time: 'e.received_at', household: true },
  locations: { select: 'l.id,l.event_id,l.device_id,l.pet_id,l.device_ts,l.received_at,l.lat,l.lon,l.accuracy_m,l.source,l.seq,l.boot_id,l.quality_flags_json',
    from: 'locations l JOIN pets p ON p.id=l.pet_id', scope: 'p.household_id=?', key: 'l.id', time: 'l.received_at', household: true, json: { quality_flags_json: 'quality_flags' } },
  activity_samples: { select: 'a.id,a.event_id,a.device_id,a.pet_id,a.start_at,a.end_at,a.steps,a.active_seconds,a.distance_m,a.sleep_seconds,a.estimated,a.source',
    from: 'activity_samples a JOIN pets p ON p.id=a.pet_id', scope: 'p.household_id=?', key: 'a.id', time: 'a.end_at', household: true, booleans: ['estimated'] },
  geofences: { select: `g.id,g.pet_id,g.name,g.geometry_json,g.enabled,g.buffer_m,g.accuracy_limit_m,g.confirm_points,g.created_at,g.updated_at,
      g.dynamic_buffer,g.min_buffer_m,g.min_exit_seconds,g.min_enter_seconds,g.rule_version`, from: 'geofences g JOIN pets p ON p.id=g.pet_id', scope: 'p.household_id=?', key: 'g.id', time: 'g.created_at', household: true, json: { geometry_json: 'geometry' }, booleans: ['enabled','dynamic_buffer'] },
  geofence_evaluations: { select: 'e.id,e.fence_id,e.location_id,e.judgment,e.state_json,e.evaluated_at,e.rule_version,e.reason,e.effective_buffer_m',
    from: 'geofence_evaluations e JOIN geofences g ON g.id=e.fence_id JOIN pets p ON p.id=g.pet_id', scope: 'p.household_id=?', key: 'e.id', time: 'e.evaluated_at', household: true, json: { state_json: 'state' } },
  safety_events: { select: 's.id,s.pet_id,s.device_id,s.fence_id,s.type,s.occurred_at,s.location_id,s.status,s.closed_at,s.related_event_id',
    from: 'safety_events s JOIN pets p ON p.id=s.pet_id', scope: 'p.household_id=?', key: 's.id', time: 's.occurred_at', household: true },
  safety_acknowledgements: { select: 'a.event_id,a.user_id,a.acknowledged_at,a.note', from: 'safety_acknowledgements a JOIN safety_events s ON s.id=a.event_id JOIN pets p ON p.id=s.pet_id', scope: 'p.household_id=?', key: 'a.event_id', time: 'a.acknowledged_at', household: true },
  care_records: { select: 'c.id,c.pet_id,c.type,c.value_json,c.recorded_at,c.source,c.notes,c.created_by,c.created_at,c.updated_at,c.withdrawn_at,c.withdrawn_by,c.withdrawal_reason,c.custom_type', from: 'care_records c JOIN pets p ON p.id=c.pet_id', scope: 'p.household_id=?', key: 'c.id', time: 'c.created_at', household: true, json: { value_json: 'value' } },
  care_record_revisions: { select: 'r.id,r.record_id,r.snapshot_json,r.changed_by,r.changed_at', from: 'care_record_revisions r JOIN care_records c ON c.id=r.record_id JOIN pets p ON p.id=c.pet_id', scope: 'p.household_id=?', key: 'r.id', time: 'r.changed_at', household: true, json: { snapshot_json: 'record' } },
  care_attachments: { select: 'a.id,a.record_id,a.filename,a.content_type,a.size_bytes,a.sha256,a.content_base64,a.created_by,a.created_at', from: 'care_attachments a JOIN care_records c ON c.id=a.record_id JOIN pets p ON p.id=c.pet_id', scope: 'p.household_id=?', key: 'a.id', time: 'a.created_at', household: true },
  reporting_policies: { select: 's.device_id,s.binding_id,s.desired_version,s.desired_json,s.applied_version,s.applied_json,s.applied_source,s.updated_at',
    from: 'reporting_policies s JOIN device_bindings b ON b.id=s.binding_id AND b.unbound_at IS NULL JOIN pets p ON p.id=b.pet_id', scope: 'p.household_id=?', key: 's.device_id', household: true, json: { desired_json: 'desired', applied_json: 'applied' } },
  device_commands: { select: 'c.id,c.device_id,c.binding_id,c.version,c.policy_json,c.status,c.expires_at,c.execution_source,c.error,c.created_at,c.acknowledged_at',
    from: 'device_commands c JOIN device_bindings b ON b.id=c.binding_id JOIN pets p ON p.id=b.pet_id', scope: 'p.household_id=?', key: 'c.id', time: 'c.created_at', household: true, json: { policy_json: 'policy' } },
  lost_mode_sessions: { select: 'l.id,l.device_id,l.binding_id,l.started_by,l.started_at,l.expires_at,l.ended_at,l.previous_policy_json', from: 'lost_mode_sessions l JOIN device_bindings b ON b.id=l.binding_id JOIN pets p ON p.id=b.pet_id', scope: 'p.household_id=?', key: 'l.id', time: 'l.started_at', household: true, json: { previous_policy_json: 'previous_policy' } },
  daily_summaries: { select: 's.pet_id,s.local_date,s.timezone,s.aggregation_version,s.source_revision,s.generated_at,s.summary_json', from: 'daily_summaries s JOIN pets p ON p.id=s.pet_id', scope: 'p.household_id=?', key: "s.pet_id||'|'||s.local_date||'|'||s.timezone", time: 's.generated_at', household: true, json: { summary_json: 'summary' } },
  activity_observations: { select: 'o.id,o.pet_id,o.local_date,o.timezone,o.rule_version,o.generated_at,o.result_json', from: 'activity_observations o JOIN pets p ON p.id=o.pet_id', scope: 'p.household_id=?', key: 'o.id', time: 'o.generated_at', household: true, json: { result_json: 'result' } },
  location_shares: { select: 's.id,s.pet_id,s.device_id,s.binding_id,s.lost_session_id,s.created_by,s.created_at,s.expires_at,s.revoked_at',
    from: 'location_shares s JOIN pets p ON p.id=s.pet_id', scope: 'p.household_id=?', key: 's.id', time: 's.created_at', household: true, write: true }
};
const exportQuery = pageQuery.extend({ limit: z.coerce.number().int().min(1).max(200).default(200), household_id: z.uuid().optional(), snapshot_at: dateTime.optional() });
const cursorSchema = z.object({ user: z.string(), section: z.string(), household: z.string().nullable(), cutoff: dateTime, after: z.string().min(1) });

export class AccountExportService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async user(id: string) {
    const user = await this.db.get('SELECT id,email,created_at FROM users WHERE id=? AND closed_at IS NULL', id);
    if (!user) fail(401, 'UNAUTHENTICATED', '账号不存在或已关闭');
    return user;
  }
  async manifest(user: string): Promise<Row> {
    return this.db.transaction(async () => {
      const profile = await this.user(user), households = (await new IdentityService(this.db).households(user)).items;
      const generated = this.db.now();
      await this.db.audit(user, 'account.export.requested', user, { household_ids: households.map(h => h.id) });
      return { format: 'doogy-account-export-v1', generated_at: generated, user: profile,
        consistency: 'paged_current_authorization_not_database_snapshot',
        personal_sections: Object.entries(sections).filter(([, spec]) => !spec.household).map(([name]) => name),
        households: households.map(h => ({ id: h.id, name: h.name, role: h.role,
          sections: Object.entries(sections).filter(([, spec]) => spec.household && (!spec.write || h.role !== 'viewer')).map(([name]) => name) })),
        excluded: ['passwords_and_authentication_hashes','device_tokens_and_hashes','push_token_values','invitation_and_share_token_values_and_hashes',
          'raw_telemetry_envelopes_and_signal','raw_activity_metrics','diagnostic_snapshots','safety_detail_snapshots','audit_metadata','household_invitation_records'] };
    });
  }
  async page(user: string, section: string, raw: unknown): Promise<Row> {
    const spec = Object.hasOwn(sections, section) ? sections[section] : undefined;
    if (!spec) fail(404, 'EXPORT_SECTION_NOT_FOUND', '导出分区不存在');
    const input = exportQuery.parse(raw), household = input.household_id ?? null;
    if (section === 'care_attachments') input.limit = 1;
    if (Boolean(spec.household) !== Boolean(household)) fail(400, 'EXPORT_SCOPE_REQUIRED', '请为家庭分区提供household_id，个人分区不接受该参数');
    await this.user(user);
    if (household) await this.db.household(user, household, spec.write);
    let after: string | null = null, cutoff = input.snapshot_at ?? this.db.now();
    if (input.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
      catch { fail(400, 'INVALID_EXPORT_CURSOR', '导出游标无效'); }
      if (cursor.user !== user || cursor.section !== section || cursor.household !== household || (input.snapshot_at && cursor.cutoff !== input.snapshot_at)) fail(400, 'INVALID_EXPORT_CURSOR', '导出游标不属于本次账号、家庭或分区');
      after = cursor.after; cutoff = cursor.cutoff;
    }
    if (cutoff > this.db.now()) fail(400, 'INVALID_EXPORT_CUTOFF', '导出截止时间不能晚于当前时间');
    const rows = await this.db.all(`SELECT ${spec.select},${spec.key} AS _export_key FROM ${spec.from} WHERE ${spec.scope}
      AND (? IS NULL OR ${spec.key}>?) ${spec.time ? `AND ${spec.time}<=?` : ''} ORDER BY ${spec.key} LIMIT ?`,
    household ?? user, after, after, ...(spec.time ? [cutoff] : []), input.limit + 1);
    await this.user(user);
    if (household) await this.db.household(user, household, spec.write);
    const items = rows.slice(0, input.limit).map(row => {
      const { _export_key, ...item } = row;
      for (const [source, target] of Object.entries(spec.json ?? {})) { item[target] = item[source] === null ? null : JSON.parse(item[source]); delete item[source]; }
      for (const key of spec.booleans ?? []) item[key] = Boolean(item[key]);
      if (spec.credential) {
        item.credential = credentialMetadata(item); delete item.credential_version; delete item.credential_status; delete item.credential_changed_at;
      }
      return item;
    });
    const next = rows.length > input.limit ? Buffer.from(JSON.stringify({ user, section, household, cutoff, after: rows[input.limit - 1]._export_key })).toString('base64url') : null;
    return { section, household_id: household, generated_at: cutoff, items, next_cursor: next };
  }
}

@ApiTags('account-export') @ApiBearerAuth() @Controller('auth/data-export')
export class AccountExportController {
  constructor(private readonly exports: AccountExportService) {}
  @Get() @Header('Cache-Control', 'no-store')
  manifest(@CurrentUser() user: string) { return this.exports.manifest(user); }
  @Get(':section') @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'household_id', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 200 } })
  @ApiQuery({ name: 'snapshot_at', required: false, type: String })
  page(@CurrentUser() user: string, @Param('section') section: string, @Query() query: unknown) { return this.exports.page(user, section, query); }
}
