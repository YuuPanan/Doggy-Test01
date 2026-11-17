import { Body, Controller, Delete, Get, Header, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody, pageQuery, Public } from './http';
import { latestLocation } from './location-quality';

const createBody = z.object({ consent: z.literal(true), expires_in_seconds: z.number().int().min(60).max(86400).default(3600) });
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const metadataColumns = 'id,pet_id,device_id,binding_id,lost_session_id,created_by,created_at,expires_at,revoked_at';
const notFound = () => fail(404, 'SHARE_NOT_FOUND', '位置分享不存在或已失效');

function publicLocation(location: Row | null): Row | null {
  return location ? { lat: location.lat, lon: location.lon, device_ts: location.device_ts, received_at: location.received_at,
    accuracy_m: location.accuracy_m, source: location.source, freshness: location.freshness,
    quality_flags: location.quality_flags, usable_for_tracking: location.usable_for_tracking } : null;
}

export class SharesService {
  constructor(@Inject(Db) readonly db: Db) {}

  async create(user: string, petId: string, raw: unknown): Promise<Row> {
    const input = createBody.parse(raw);
    return await this.db.transaction(async () => {
      await this.db.pet(user, petId, true);
      const binding = await this.db.get('SELECT * FROM device_bindings WHERE pet_id=? AND unbound_at IS NULL', petId);
      if (!binding) fail(409, 'DEVICE_NOT_BOUND', '宠物尚未绑定设备');
      const session = await this.db.get('SELECT id,expires_at FROM lost_mode_sessions WHERE binding_id=? AND ended_at IS NULL AND expires_at>?', binding.id, this.db.now());
      if (!session) fail(409, 'LOST_MODE_REQUIRED', '请先开启走失模式再分享位置');
      const id = this.db.id(), token = randomBytes(32).toString('base64url');
      const expires = new Date(Math.min(this.db.clock().getTime() + input.expires_in_seconds * 1000, Date.parse(session.expires_at))).toISOString();
      await this.db.run(`INSERT INTO location_shares(id,pet_id,device_id,binding_id,lost_session_id,created_by,token_hash,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, petId, binding.device_id, binding.id, session.id, user, hash(token), this.db.now(), expires);
      await this.db.audit(user, 'location_share.created', id, { pet_id: petId, expires_at: expires });
      return { ...(await this.db.get(`SELECT ${metadataColumns} FROM location_shares WHERE id=?`, id))!, token,
        public_path: `/api/v1/location-shares/${token}` };
    });
  }

  async list(user: string, petId: string, raw: unknown = {}) {
    await this.db.pet(user, petId, true);
    const query = pageQuery.parse(raw);
    const cursor = query.cursor ? (await this.db.get('SELECT id,created_at FROM location_shares WHERE id=? AND pet_id=?', query.cursor, petId)) : null;
    if (query.cursor && !cursor) fail(400, 'INVALID_CURSOR', '分页游标不正确');
    const rows = await this.db.all(`SELECT ${metadataColumns} FROM location_shares WHERE pet_id=?
      AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
      petId, cursor?.id ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.id ?? null, query.limit + 1);
    return { items: rows.slice(0, query.limit), next_cursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
  }

  async revoke(user: string, shareId: string) {
    return await this.db.transaction(async () => {
      const share = await this.db.get('SELECT * FROM location_shares WHERE id=?', shareId);
      if (!share) return notFound();
      const pet = await this.db.pet(user, share.pet_id);
      const member = await this.db.household(user, pet.household_id);
      if (share.created_by !== user && member.role !== 'owner') fail(403, 'SHARE_OWNER_REQUIRED', '仅分享创建者或家庭所有者可撤销分享');
      if (!share.revoked_at) {
        await this.db.run('UPDATE location_shares SET revoked_at=? WHERE id=?', this.db.now(), shareId);
        await this.db.audit(user, 'location_share.revoked', shareId);
      }
      return (await this.db.get(`SELECT ${metadataColumns} FROM location_shares WHERE id=?`, shareId))!;
    });
  }

  async resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound();
    // Keep grant checks and current-binding location reads in one snapshot.
    return await this.db.transaction(async () => {
      const share = await this.db.get(`SELECT s.*,p.name AS pet_name FROM location_shares s
        JOIN pets p ON p.id=s.pet_id JOIN household_members m ON m.household_id=p.household_id AND m.user_id=s.created_by
        JOIN device_bindings b ON b.id=s.binding_id AND b.device_id=s.device_id AND b.pet_id=s.pet_id
        JOIN lost_mode_sessions l ON l.id=s.lost_session_id AND l.binding_id=s.binding_id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND b.unbound_at IS NULL
        AND l.ended_at IS NULL AND l.expires_at>? AND m.role IN ('owner','caregiver')`, hash(token), this.db.now(), this.db.now());
      if (!share) return notFound();
      const latest = await latestLocation(this.db, share.pet_id);
      return { share_id: share.id, pet: { id: share.pet_id, name: share.pet_name }, expires_at: share.expires_at,
        location: publicLocation(latest), last_usable_location: publicLocation(latest?.last_usable_location ?? null) };
    });
  }
}

@ApiTags('location-sharing')
@Controller()
export class SharesController {
  constructor(@Inject(SharesService) readonly shares: SharesService) {}
  @ApiBearerAuth() @Post('pets/:id/location-shares') @JsonBody(createBody) @Header('Cache-Control', 'no-store')
  create(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown) { return this.shares.create(user, id, body); }
  @ApiBearerAuth() @Get('pets/:id/location-shares')
  list(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.shares.list(user, id, query); }
  @ApiBearerAuth() @Delete('location-shares/:id')
  revoke(@CurrentUser() user: string, @Param('id') id: string) { return this.shares.revoke(user, id); }
  @Public() @Get('location-shares/:token') @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer')
  resolve(@Param('token') token: string) { return this.shares.resolve(token); }
}
