import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';
import { geometrySchema } from './geofence-engine';
import { settings } from './config';
import { deviceTiming } from './reporting';

const fields = z.object({
  name: z.string().trim().min(1).max(100), geometry: geometrySchema, enabled: z.boolean(),
  buffer_m: z.number().min(0).max(500), accuracy_limit_m: z.number().positive().max(500), confirm_points: z.number().int().min(2).max(10),
  dynamic_buffer: z.boolean(), min_buffer_m: z.number().min(0).max(500),
  min_exit_seconds: z.number().int().min(0).max(3600), min_enter_seconds: z.number().int().min(0).max(3600)
});
const createSchema = fields.extend({ pet_id: z.uuid(), enabled: fields.shape.enabled.default(true), buffer_m: fields.shape.buffer_m.default(10),
  accuracy_limit_m: fields.shape.accuracy_limit_m.default(100), confirm_points: fields.shape.confirm_points.default(2),
  dynamic_buffer: fields.shape.dynamic_buffer.default(false), min_buffer_m: fields.shape.min_buffer_m.default(15),
  min_exit_seconds: fields.shape.min_exit_seconds.default(0), min_enter_seconds: fields.shape.min_enter_seconds.default(0) });
const patchSchema = fields.partial();

export class FencesService {
  constructor(@Inject(Db) readonly db: Db) {}
  async present(row: Row): Promise<Row> {
    const { geometry_json, ...rest } = row;
    const state = (await this.db.get('SELECT * FROM geofence_states WHERE fence_id=?', row.id))!;
    const location = state.last_location_id ? (await this.db.get('SELECT device_id FROM locations WHERE id=?', state.last_location_id)) : null;
    const freshSeconds = location ? (await deviceTiming(this.db, location.device_id)).fresh_seconds : settings().FRESH_SECONDS;
    const fresh = state.last_ts && this.db.clock().getTime() - Date.parse(state.last_ts) <= freshSeconds * 1000;
    return { ...rest, enabled: Boolean(row.enabled), dynamic_buffer: Boolean(row.dynamic_buffer), geometry: JSON.parse(geometry_json),
      state: { ...state, effective_status: !row.enabled || !fresh || state.last_judgment === 'uncertain' ? 'unknown' : state.status } };
  }
  async list(user: string, petId: string) {
    await this.db.pet(user, petId);
    const rows = await this.db.all('SELECT * FROM geofences WHERE pet_id=? ORDER BY created_at,id', petId);
    return { items: await Promise.all(rows.map(row => this.present(row))) };
  }
  async create(user: string, raw: unknown, key?: string) {
    const input = createSchema.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, input.pet_id, true);
      return this.db.idempotent(user, 'POST /geofences', key, input, async () => {
        const id = this.db.id();
        await this.db.run(`INSERT INTO geofences(id,pet_id,name,geometry_json,enabled,buffer_m,accuracy_limit_m,confirm_points,created_at,updated_at,
          dynamic_buffer,min_buffer_m,min_exit_seconds,min_enter_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.pet_id, input.name, JSON.stringify(input.geometry), Number(input.enabled),
          input.buffer_m, input.accuracy_limit_m, input.confirm_points, this.db.now(), this.db.now(),
          Number(input.dynamic_buffer), input.min_buffer_m, input.min_exit_seconds, input.min_enter_seconds);
        await this.db.run('INSERT INTO geofence_states(fence_id) VALUES (?)', id);
        await this.db.audit(user, 'geofence.created', id, { pet_id: input.pet_id });
        return await this.present((await this.db.get('SELECT * FROM geofences WHERE id=?', id))!);
      });
    });
  }
  async update(user: string, id: string, raw: unknown) {
    const input = patchSchema.parse(raw);
    return await this.db.transaction(async () => {
      const fence = await this.db.get('SELECT * FROM geofences WHERE id=?', id);
      if (!fence) fail(404, 'NOT_FOUND', '围栏不存在');
      await this.db.pet(user, fence.pet_id, true);
      const changedRules = ['geometry', 'enabled', 'buffer_m', 'accuracy_limit_m', 'confirm_points', 'dynamic_buffer', 'min_buffer_m', 'min_exit_seconds', 'min_enter_seconds'].some(key => key in input);
      await this.db.run(`UPDATE geofences SET name=?,geometry_json=?,enabled=?,buffer_m=?,accuracy_limit_m=?,confirm_points=?,updated_at=?,
        dynamic_buffer=?,min_buffer_m=?,min_exit_seconds=?,min_enter_seconds=?,rule_version=rule_version+? WHERE id=?`,
        input.name ?? fence.name, input.geometry ? JSON.stringify(input.geometry) : fence.geometry_json, Number(input.enabled ?? Boolean(fence.enabled)),
        input.buffer_m ?? fence.buffer_m, input.accuracy_limit_m ?? fence.accuracy_limit_m, input.confirm_points ?? fence.confirm_points, this.db.now(),
        Number(input.dynamic_buffer ?? Boolean(fence.dynamic_buffer)), input.min_buffer_m ?? fence.min_buffer_m,
        input.min_exit_seconds ?? fence.min_exit_seconds, input.min_enter_seconds ?? fence.min_enter_seconds, Number(changedRules), id);
      if (changedRules) {
        await this.db.run("UPDATE safety_events SET status='closed',closed_at=? WHERE fence_id=? AND status='open'", this.db.now(), id);
        await this.db.run("UPDATE geofence_states SET status='unknown',candidate=NULL,candidate_since=NULL,count=0,last_ts=NULL,last_location_id=NULL,open_event_id=NULL,last_judgment='unknown' WHERE fence_id=?", id);
      }
      await this.db.audit(user, input.enabled === false ? 'geofence.disabled' : 'geofence.updated', id);
      return await this.present((await this.db.get('SELECT * FROM geofences WHERE id=?', id))!);
    });
  }
}
@ApiTags('geofences') @ApiBearerAuth()
@Controller()
export class FencesController {
  constructor(@Inject(FencesService) readonly fences: FencesService) {}
  @Get('pets/:id/geofences') async list(@CurrentUser() user: string, @Param('id') id: string) { return await this.fences.list(user, id); }
  @Post('geofences') @JsonBody(createSchema) @ApiHeader({ name: 'Idempotency-Key', required: false })
  async create(@CurrentUser() user: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return await this.fences.create(user, body, key); }
  @Patch('geofences/:id') @JsonBody(patchSchema) async update(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return await this.fences.update(user, id, body); }
  @Delete('geofences/:id') async disable(@CurrentUser() user: string, @Param('id') id: string) { return await this.fences.update(user, id, { enabled: false }); }
}
