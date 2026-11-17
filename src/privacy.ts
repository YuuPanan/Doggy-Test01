import { Body, Controller, Delete, Get, Header, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';
import { IdentityService } from './identity';
import { clearDeviceReporting } from './reporting';
import { withdrawCareRecord } from './care';

const password = z.string().min(8).max(128);
const accountBody = z.object({ password, confirmation: z.literal('DELETE') });
const deleteBody = z.object({ password, confirmation: z.uuid() });
const transferBody = z.object({ password, new_owner_user_id: z.uuid() });
export const deletionReceipt = z.object({ id: z.uuid(), kind: z.enum(['account','pet','household','ownership_transfer','care_withdrawal']),
  resource_id: z.uuid(), deleted_at: z.iso.datetime(), payload: z.object({ new_owner_user_id: z.uuid(), previous_owner_user_id: z.uuid(), device_ids: z.array(z.uuid()) }).optional() });

export class PrivacyService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async owner(user: string, household: string) {
    if ((await this.db.household(user, household)).role !== 'owner') fail(403, 'OWNER_REQUIRED', '只有家庭所有者可以删除共享数据或转移所有权');
  }
  private async clearDevice(device: string) {
    await this.db.run(`UPDATE device_state SET last_seen_at=NULL,reported_at=NULL,battery_pct=NULL,signal_json=NULL,
      firmware_version=NULL,last_location_id=NULL,connection_status='unknown',reported_seq=NULL,reported_boot_id=NULL,signal_event_id=NULL WHERE device_id=?`, device);
    await clearDeviceReporting(this.db, device);
  }
  private async scrubCopies(ids: Set<string>) {
    const contains = (value: unknown): boolean => typeof value === 'string' ? ids.has(value) :
      Array.isArray(value) ? value.some(contains) : Boolean(value && typeof value === 'object' && Object.values(value).some(contains));
    // Explicit deletion must also remove cached responses that can replay the erased records.
    for (const row of await this.db.all('SELECT user_id,scope,key,request_json,response_json FROM idempotency_keys')) {
      if (contains(JSON.parse(row.request_json)) || contains(JSON.parse(row.response_json))) {
        await this.db.run('DELETE FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', row.user_id, row.scope, row.key);
      }
    }
    for (const row of await this.db.all('SELECT id,resource_id,metadata_json FROM audit_logs')) {
      if (ids.has(row.resource_id) || contains(JSON.parse(row.metadata_json))) await this.db.run('DELETE FROM audit_logs WHERE id=?', row.id);
    }
  }
  private async erasePet(pet: string, record = true) {
    const row = await this.db.get('SELECT household_id FROM pets WHERE id=?', pet);
    if (!row) return;
    const ids = new Set<string>([pet]);
    for (const [table,key,scope] of [
      ['device_bindings','id','pet_id=?'], ['device_events','event_id','pet_id=?'], ['locations','id','pet_id=?'],
      ['activity_samples','id','pet_id=?'], ['geofences','id','pet_id=?'], ['safety_events','id','pet_id=?'],
      ['care_records','id','pet_id=?'], ['support_tickets','id','pet_id=?'], ['location_shares','id','pet_id=?'],
      ['care_attachments','id','record_id IN (SELECT id FROM care_records WHERE pet_id=?)'],
      ['device_commands','id','binding_id IN (SELECT id FROM device_bindings WHERE pet_id=?)'],
      ['lost_mode_sessions','id','binding_id IN (SELECT id FROM device_bindings WHERE pet_id=?)']
    ]) for (const item of await this.db.all(`SELECT ${key} AS id FROM ${table} WHERE ${scope}`, pet)) ids.add(item.id);
    for (const binding of await this.db.all(`SELECT DISTINCT b.device_id FROM device_bindings b WHERE b.pet_id=?
      AND (b.unbound_at IS NULL OR NOT EXISTS (SELECT 1 FROM device_bindings active WHERE active.device_id=b.device_id AND active.unbound_at IS NULL))`, pet)) {
      await this.db.run('UPDATE device_bindings SET unbound_at=? WHERE device_id=? AND unbound_at IS NULL', this.db.now(), binding.device_id);
      await this.clearDevice(binding.device_id);
    }
    await this.db.run('UPDATE device_state SET last_location_id=NULL WHERE last_location_id IN (SELECT id FROM locations WHERE pet_id=?)', pet);
    // Historical pointers may remain after hardware moves to another family.
    await this.db.run('UPDATE safety_events SET location_id=NULL WHERE location_id IN (SELECT id FROM locations WHERE pet_id=?)', pet);
    await this.db.run('DELETE FROM geofence_evaluations WHERE location_id IN (SELECT id FROM locations WHERE pet_id=?)', pet);
    for (const sql of [
      'DELETE FROM location_shares WHERE pet_id=?',
      'DELETE FROM support_ticket_history WHERE ticket_id IN (SELECT id FROM support_tickets WHERE pet_id=?)',
      'DELETE FROM support_tickets WHERE pet_id=?',
      'DELETE FROM reporting_policies WHERE binding_id IN (SELECT id FROM device_bindings WHERE pet_id=?)',
      'DELETE FROM device_commands WHERE binding_id IN (SELECT id FROM device_bindings WHERE pet_id=?)',
      'DELETE FROM lost_mode_sessions WHERE binding_id IN (SELECT id FROM device_bindings WHERE pet_id=?)',
      'DELETE FROM notifications WHERE event_id IN (SELECT id FROM safety_events WHERE pet_id=?)',
      'DELETE FROM safety_acknowledgements WHERE event_id IN (SELECT id FROM safety_events WHERE pet_id=?)',
      'DELETE FROM geofence_evaluations WHERE fence_id IN (SELECT id FROM geofences WHERE pet_id=?)',
      'DELETE FROM geofence_states WHERE fence_id IN (SELECT id FROM geofences WHERE pet_id=?)',
      'DELETE FROM safety_events WHERE pet_id=?', 'DELETE FROM geofences WHERE pet_id=?',
      'DELETE FROM care_record_revisions WHERE record_id IN (SELECT id FROM care_records WHERE pet_id=?)',
      'DELETE FROM care_attachments WHERE record_id IN (SELECT id FROM care_records WHERE pet_id=?)',
      'DELETE FROM care_records WHERE pet_id=?', 'DELETE FROM behavior_feedback WHERE pet_id=?',
      'DELETE FROM activity_samples WHERE pet_id=?', 'DELETE FROM locations WHERE pet_id=?',
      "UPDATE device_events SET pet_id=NULL,binding_id=NULL,payload_json='{}',envelope_json='{}',process_status='dead',error='DATA_DELETED' WHERE pet_id=?",
      'DELETE FROM device_bindings WHERE pet_id=?',
      'DELETE FROM daily_summaries WHERE pet_id=?', 'DELETE FROM activity_observations WHERE pet_id=?',
      'DELETE FROM activity_versions WHERE pet_id=?', 'DELETE FROM pet_settings WHERE pet_id=?', 'DELETE FROM pets WHERE id=?'
    ]) await this.db.run(sql, pet);
    await this.scrubCopies(ids);
    if (record) await this.db.recordDeletion('pet', pet);
  }
  private async eraseHousehold(household: string, record = true) {
    if (!await this.db.get('SELECT id FROM households WHERE id=?', household)) return;
    for (const pet of await this.db.all('SELECT id FROM pets WHERE household_id=?', household)) await this.erasePet(pet.id, record);
    await this.db.run('DELETE FROM household_invitations WHERE household_id=?', household);
    await this.db.run('DELETE FROM household_members WHERE household_id=?', household);
    await this.db.run('DELETE FROM household_settings WHERE household_id=?', household);
    await this.db.run('DELETE FROM household_retention WHERE household_id=?', household);
    await this.db.run('DELETE FROM households WHERE id=?', household);
    await this.scrubCopies(new Set([household]));
    if (record) await this.db.recordDeletion('household', household);
  }
  async accountPreview(user: string) {
    const profile = await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', user);
    if (!profile) fail(401, 'UNAUTHENTICATED', '账号不存在或已注销');
    const households = await this.db.all(`SELECT h.id,h.name,m.role,(SELECT COUNT(*) FROM household_members x WHERE x.household_id=h.id) AS members
      FROM households h JOIN household_members m ON m.household_id=h.id WHERE m.user_id=? ORDER BY h.id`, user);
    const solo = households.filter(h => h.role === 'owner' && h.members === 1).map(h => h.id);
    const blockers: Row[] = households.filter(h => h.role === 'owner' && h.members > 1).map(h => ({ code: 'OWNER_TRANSFER_REQUIRED', household_id: h.id }));
    const owned = await this.db.all(`SELECT d.id,b.pet_id,p.household_id FROM devices d LEFT JOIN device_bindings b ON b.device_id=d.id AND b.unbound_at IS NULL
      LEFT JOIN pets p ON p.id=b.pet_id WHERE d.owner_user_id=?`, user);
    for (const d of owned) if (d.pet_id && !solo.includes(d.household_id)) blockers.push({ code: 'DEVICE_RELEASE_REQUIRED', device_id: d.id, household_id: d.household_id });
    return { can_close: blockers.length === 0, blockers, households_to_delete: solo,
      shared_households_to_leave: households.filter(h => !solo.includes(h.id)).map(h => h.id),
      owned_devices_to_release: owned.map(d => d.id), shared_authorship: 'retained_with_closed_anonymous_user_id',
      historical_backups: 'replay_deletion_log_before_reopening' };
  }
  private async eraseAccount(user: string, record = true) {
    const profile = await this.db.get('SELECT * FROM users WHERE id=?', user);
    if (!profile || profile.closed_at) return;
    const preview = await this.accountPreview(user);
    if (preview.blockers.length) fail(409, preview.blockers[0].code, '请先转移家庭所有权，或解绑并释放仍在共享家庭使用的自有设备；详情见注销预览');
    for (const household of preview.households_to_delete) await this.eraseHousehold(household, record);
    for (const device of await this.db.all('SELECT id FROM devices WHERE owner_user_id=?', user)) {
      await this.clearDevice(device.id);
      await this.db.run(`UPDATE devices SET owner_user_id=NULL,claim_hash=NULL,claim_expires_at=NULL,claim_attempts=0,
        secret_hash=?,credential_status='revoked',credential_changed_at=? WHERE id=?`, randomBytes(32).toString('hex'), this.db.now(), device.id);
    }
    await this.db.run('DELETE FROM household_members WHERE user_id=?', user);
    await this.db.run('DELETE FROM household_invitations WHERE invited_by=? OR email=?', user, profile.email);
    await this.db.run('DELETE FROM location_shares WHERE created_by=?', user);
    await this.db.run('DELETE FROM support_ticket_history WHERE ticket_id IN (SELECT id FROM support_tickets WHERE created_by=?)', user);
    await this.db.run('DELETE FROM support_tickets WHERE created_by=?', user);
    await this.db.run("UPDATE support_ticket_history SET reply='' WHERE actor_id=?", user);
    await this.db.run('DELETE FROM safety_acknowledgements WHERE user_id=?', user);
    for (const table of ['sessions','push_tokens','notification_preferences','notifications','idempotency_keys']) await this.db.run(`DELETE FROM ${table} WHERE user_id=?`, user);
    await this.db.run('DELETE FROM behavior_feedback WHERE created_by=?', user);
    await this.db.run('DELETE FROM auth_attempts WHERE key=?', profile.email);
    await this.db.run('DELETE FROM audit_logs WHERE actor_id=?', user);
    await this.scrubCopies(new Set([user]));
    await this.db.run('UPDATE users SET email=?,password_hash=?,closed_at=? WHERE id=?', `closed:${user}`, '', this.db.now(), user);
    if (record) await this.db.recordDeletion('account', user);
  }
  async closeAccount(user: string, raw: unknown) {
    const input = accountBody.parse(raw);
    return this.db.transaction(async () => {
      await new IdentityService(this.db).verifyPassword(user, input.password);
      await this.eraseAccount(user);
      return { closed: true, shared_authorship: 'retained_with_closed_anonymous_user_id' };
    });
  }
  async petPreview(user: string, pet: string) {
    const row = await this.db.pet(user, pet); await this.owner(user, row.household_id);
    const counts: Row = {};
    for (const table of ['device_bindings','device_events','locations','activity_samples','geofences','safety_events','care_records','support_tickets','location_shares','daily_summaries','activity_observations']) {
      counts[table] = (await this.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE pet_id=?`, pet))!.n;
    }
    counts.care_attachments = (await this.db.get('SELECT COUNT(*) AS n FROM care_attachments a JOIN care_records c ON c.id=a.record_id WHERE c.pet_id=?', pet))!.n;
    return { pet_id: pet, household_id: row.household_id, shared_with_members: (await this.db.get('SELECT COUNT(*) AS n FROM household_members WHERE household_id=?', row.household_id))!.n,
      counts, effects: ['all_pet_business_data_and_copies_erased','current_devices_unbound_inventory_preserved'], confirmation: pet };
  }
  async deletePet(user: string, pet: string, raw: unknown) {
    const input = deleteBody.parse(raw);
    if (input.confirmation !== pet) fail(400, 'CONFIRMATION_REQUIRED', '请确认待删除宠物ID');
    return this.db.transaction(async () => {
      await new IdentityService(this.db).verifyPassword(user, input.password);
      const row = await this.db.pet(user, pet); await this.owner(user, row.household_id);
      await this.erasePet(pet); return { deleted: true, pet_id: pet };
    });
  }
  async householdPreview(user: string, household: string) {
    await this.owner(user, household);
    return { household_id: household, members: (await this.db.get('SELECT COUNT(*) AS n FROM household_members WHERE household_id=?', household))!.n,
      pets: await this.db.all('SELECT id FROM pets WHERE household_id=?', household), confirmation: household, effects: ['all_shared_household_business_data_erased','member_accounts_and_hardware_inventory_preserved'] };
  }
  async deleteHousehold(user: string, household: string, raw: unknown) {
    const input = deleteBody.parse(raw);
    if (input.confirmation !== household) fail(400, 'CONFIRMATION_REQUIRED', '请确认待删除家庭ID');
    return this.db.transaction(async () => {
      await new IdentityService(this.db).verifyPassword(user, input.password); await this.owner(user, household);
      await this.eraseHousehold(household); return { deleted: true, household_id: household };
    });
  }
  private async moveOwner(household: string, previous: string, target: string, deviceIds?: string[]) {
    if (previous === target) fail(400, 'SAME_OWNER', '请选择其他家庭成员');
    if (!await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', target)) fail(409, 'OWNER_TARGET_UNAVAILABLE', '目标账号不存在或已注销');
    if (!await this.db.get('SELECT user_id FROM household_members WHERE household_id=? AND user_id=?', household, target)) fail(409, 'OWNER_TARGET_NOT_MEMBER', '目标账号必须已经是家庭成员');
    await this.db.run("UPDATE household_members SET role='caregiver' WHERE household_id=? AND user_id=?", household, previous);
    await this.db.run("UPDATE household_members SET role='owner' WHERE household_id=? AND user_id=?", household, target);
    await this.db.run('UPDATE households SET owner_user_id=? WHERE id=?', target, household);
    const devices = deviceIds ?? (await this.db.all(`SELECT d.id FROM devices d JOIN device_bindings b ON b.device_id=d.id AND b.unbound_at IS NULL
      JOIN pets p ON p.id=b.pet_id WHERE p.household_id=? AND d.owner_user_id=?`, household, previous)).map(d => d.id);
    for (const device of devices) await this.db.run('UPDATE devices SET owner_user_id=? WHERE id=? AND owner_user_id=?', target, device, previous);
    return devices;
  }
  async transferOwner(user: string, household: string, raw: unknown) {
    const input = transferBody.parse(raw);
    return this.db.transaction(async () => {
      await new IdentityService(this.db).verifyPassword(user, input.password); await this.owner(user, household);
      const devices = await this.moveOwner(household, user, input.new_owner_user_id);
      const receipt = await this.db.recordDeletion('ownership_transfer', household, { previous_owner_user_id: user, new_owner_user_id: input.new_owner_user_id, device_ids: devices });
      return { household_id: household, owner_user_id: input.new_owner_user_id, transferred_devices: devices, receipt_id: receipt.id };
    });
  }
  async receipts() {
    return (await this.db.all('SELECT * FROM privacy_deletions ORDER BY deleted_at,id')).map(row => ({ id: row.id, kind: row.kind, resource_id: row.resource_id, deleted_at: row.deleted_at,
      ...(row.kind === 'ownership_transfer' ? { payload: JSON.parse(row.payload_json) } : {}) }));
  }
  async replay(raw: unknown) {
    const receipts = z.array(deletionReceipt).parse(raw).sort((a,b) => a.deleted_at.localeCompare(b.deleted_at));
    return this.db.transaction(async () => {
      let applied = 0;
      for (const row of receipts) {
        if (await this.db.get('SELECT id FROM privacy_deletions WHERE id=?', row.id)) continue;
        if (row.kind === 'pet') await this.erasePet(row.resource_id, false);
        if (row.kind === 'household') await this.eraseHousehold(row.resource_id, false);
        if (row.kind === 'account') await this.eraseAccount(row.resource_id, false);
        if (row.kind === 'care_withdrawal') await withdrawCareRecord(this.db, row.resource_id, row.deleted_at, null, '恢复撤回记录');
        if (row.kind === 'ownership_transfer') {
          if (!row.payload) fail(400, 'INVALID_DELETION_RECEIPT', '所有权转移记录缺少目标');
          const household = await this.db.get('SELECT owner_user_id FROM households WHERE id=?', row.resource_id);
          if (household && household.owner_user_id === row.payload.previous_owner_user_id) {
            await this.moveOwner(row.resource_id, row.payload.previous_owner_user_id, row.payload.new_owner_user_id, row.payload.device_ids);
          }
        }
        await this.db.run('INSERT INTO privacy_deletions VALUES (?,?,?,?,?)', row.id, row.kind, row.resource_id, row.deleted_at, JSON.stringify(row.payload ?? {}));
        applied++;
      }
      return { applied, total: receipts.length };
    });
  }
}

@ApiTags('privacy') @ApiBearerAuth() @Controller()
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}
  @Get('auth/account-deletion') @Header('Cache-Control', 'no-store')
  accountPreview(@CurrentUser() user: string) { return this.privacy.accountPreview(user); }
  @Delete('auth/account') @JsonBody(accountBody) @Header('Cache-Control', 'no-store')
  close(@CurrentUser() user: string, @Body() body: unknown) { return this.privacy.closeAccount(user, body); }
  @Get('pets/:id/deletion-preview') @Header('Cache-Control', 'no-store')
  petPreview(@CurrentUser() user: string, @Param('id') id: string) { return this.privacy.petPreview(user, id); }
  @Delete('pets/:id') @JsonBody(deleteBody)
  pet(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.privacy.deletePet(user, id, body); }
  @Get('households/:id/deletion-preview') @Header('Cache-Control', 'no-store')
  householdPreview(@CurrentUser() user: string, @Param('id') id: string) { return this.privacy.householdPreview(user, id); }
  @Delete('households/:id') @JsonBody(deleteBody)
  household(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.privacy.deleteHousehold(user, id, body); }
  @Post('households/:id/owner') @JsonBody(transferBody)
  transfer(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.privacy.transferOwner(user, id, body); }
}
