import { Body, CanActivate, Controller, Delete, ExecutionContext, Get, Headers, HttpCode, Injectable, Param, Patch, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody, Public } from './http';

const email = z.email().max(254).transform(value => value.toLowerCase());
export const timezoneSchema = z.string().min(1).max(100).refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, '时区必须为有效 IANA 时区');
const credentials = z.object({ email, password: z.string().min(8).max(128) });
const registration = credentials.extend({ household_name: z.string().trim().min(1).max(100).default('我的家庭'), timezone: timezoneSchema.default('Asia/Shanghai') });
const householdBody = z.object({ name: z.string().trim().min(1).max(100).optional(), timezone: timezoneSchema.optional() });
const refreshBody = z.object({ refresh_token: z.string().min(20).max(200) });
const inviteBody = z.object({ email, role: z.enum(['caregiver', 'viewer']).default('viewer') });
const memberBody = z.object({ role: z.enum(['caregiver', 'viewer']) });
const petFields = z.object({
  name: z.string().trim().min(1).max(100), species: z.enum(['dog', 'cat', 'other']).default('dog'),
  breed: z.string().max(100).nullable().optional(), birth_date: z.iso.date().nullable().optional(),
  weight_kg: z.number().positive().max(300).nullable().optional(),
  timezone: timezoneSchema.nullable().optional(),
});
const newPetBody = petFields.extend({ household_id: z.uuid() });
const patchPetBody = petFields.extend({ species: z.enum(['dog', 'cat', 'other']) }).partial();
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const publicUser = (user: Row) => ({ id: user.id, email: user.email, created_at: user.created_at });

export async function timezoneForPet(db: Db, petId: string, requested?: string) {
  if (requested !== undefined) return timezoneSchema.parse(requested);
  return (await db.get(`SELECT COALESCE(ps.timezone,hs.timezone,'Asia/Shanghai') AS timezone FROM pets p
    LEFT JOIN pet_settings ps ON ps.pet_id=p.id LEFT JOIN household_settings hs ON hs.household_id=p.household_id WHERE p.id=?`, petId))!.timezone as string;
}
export async function presentPet(db: Db, row: Row): Promise<Row> {
  return { ...row, timezone: (await db.get('SELECT timezone FROM pet_settings WHERE pet_id=?', row.id))?.timezone ?? null,
    effective_timezone: await timezoneForPet(db, row.id) };
}

function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function matchesPassword(password: string, saved: string) {
  const [salt, key] = saved.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex'));
}

@Injectable()
export class IdentityService {
  constructor(private readonly db: Db) {}

  private async issueSession(userId: string) {
    if (!await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', userId)) fail(401, 'UNAUTHENTICATED', '账号不存在或已注销');
    const access = newToken(), refresh = newToken(), now = this.db.clock().getTime();
    const expires = new Date(now + 30 * 60_000).toISOString();
    const refreshExpires = new Date(now + 30 * 86400_000).toISOString();
    await this.db.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)', this.db.id(), userId, hashToken(access), hashToken(refresh), expires, refreshExpires, this.db.now());
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_at: expires, refresh_expires_at: refreshExpires };
  }

  async register(body: unknown) {
    const input = registration.parse(body);
    const encoded = passwordHash(input.password);
    return await this.db.transaction(async () => {
      if ((await this.db.get('SELECT id FROM users WHERE email=?', input.email))) fail(409, 'EMAIL_EXISTS', '邮箱已注册');
      const userId = this.db.id(), householdId = this.db.id(), now = this.db.now();
      await this.db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', userId, input.email, encoded, now);
      await this.db.run('INSERT INTO households VALUES (?,?,?,?)', householdId, input.household_name, userId, now);
      await this.db.run('INSERT INTO household_settings VALUES (?,?)', householdId, input.timezone);
      await this.db.run('INSERT INTO household_members VALUES (?,?,?,?)', householdId, userId, 'owner', now);
      await this.db.audit(userId, 'account.register', userId);
      return { user: { id: userId, email: input.email, created_at: now }, household: { id: householdId, name: input.household_name, owner_user_id: userId, created_at: now, timezone: input.timezone }, ...(await this.issueSession(userId)) };
    });
  }

  async login(body: unknown) {
    const input = credentials.parse(body);
    await this.db.transaction(async () => {
      const previous = await this.db.get('SELECT * FROM auth_attempts WHERE key=?', input.email);
      const active = previous && this.db.clock().getTime() - Date.parse(previous.window_started) < 10 * 60_000;
      if (active && previous.attempts >= 10) fail(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请稍后再试');
      await this.db.run('INSERT INTO auth_attempts VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_started=excluded.window_started,attempts=excluded.attempts', input.email, active ? previous.window_started : this.db.now(), active ? previous.attempts + 1 : 1);
    });
    const user = await this.db.get('SELECT * FROM users WHERE email=? AND closed_at IS NULL', input.email);
    if (!user || !matchesPassword(input.password, user.password_hash)) fail(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
    return await this.db.transaction(async () => {
      await this.db.run('DELETE FROM auth_attempts WHERE key=?', input.email);
      return { user: publicUser(user), ...(await this.issueSession(user.id)) };
    });
  }

  async refresh(body: unknown) {
    const { refresh_token } = refreshBody.parse(body);
    return await this.db.transaction(async () => {
      const session = await this.db.get('SELECT * FROM sessions WHERE refresh_hash=? AND refresh_expires_at>?', hashToken(refresh_token), this.db.now());
      if (!session) fail(401, 'INVALID_REFRESH_TOKEN', '刷新令牌无效或已过期');
      await this.db.run('DELETE FROM sessions WHERE id=?', session.id);
      return await this.issueSession(session.user_id);
    });
  }

  async userFromAccess(token: string) {
    const session = await this.db.get('SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=? AND s.expires_at>? AND u.closed_at IS NULL', hashToken(token), this.db.now());
    if (!session) fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
    return session.user_id as string;
  }

  async verifyPassword(userId: string, password: string) {
    const user = await this.db.get('SELECT * FROM users WHERE id=? AND closed_at IS NULL', userId);
    if (!user || !matchesPassword(password, user.password_hash)) fail(401, 'INVALID_CREDENTIALS', '密码错误或账号已注销');
    return user;
  }
  async me(userId: string) {
    const user = await this.db.get('SELECT * FROM users WHERE id=? AND closed_at IS NULL', userId);
    if (!user) fail(401, 'UNAUTHENTICATED', '账号不存在或已注销');
    return publicUser(user);
  }
  async logout(authorization: string) {
    await this.db.run('DELETE FROM sessions WHERE access_hash=?', hashToken(authorization.replace(/^Bearer /i, '')));
    return { logged_out: true };
  }
  async households(userId: string) {
    return { items: await this.db.all("SELECT h.*,m.role,COALESCE(s.timezone,'Asia/Shanghai') AS timezone FROM households h JOIN household_members m ON m.household_id=h.id LEFT JOIN household_settings s ON s.household_id=h.id WHERE m.user_id=? ORDER BY h.created_at,h.id", userId) };
  }
  async updateHousehold(userId: string, householdId: string, body: unknown) {
    const input = householdBody.parse(body);
    if (!Object.keys(input).length) fail(400, 'EMPTY_UPDATE', '请提供至少一个待修改字段');
    return await this.db.transaction(async () => {
      await this.owner(userId, householdId);
      if (input.name !== undefined) await this.db.run('UPDATE households SET name=? WHERE id=?', input.name, householdId);
      if (input.timezone !== undefined) await this.db.run('INSERT INTO household_settings VALUES (?,?) ON CONFLICT(household_id) DO UPDATE SET timezone=excluded.timezone', householdId, input.timezone);
      await this.db.audit(userId, 'household.update', householdId, { fields: Object.keys(input) });
      return (await this.households(userId)).items.find(row => row.id === householdId)!;
    });
  }
  private async owner(userId: string, householdId: string) {
    const member = await this.db.household(userId, householdId);
    if (member.role !== 'owner') fail(403, 'OWNER_REQUIRED', '只有家庭所有者可以管理家庭设置和成员');
  }
  async members(userId: string, householdId: string) {
    await this.db.household(userId, householdId);
    return { items: await this.db.all('SELECT m.user_id,m.role,m.created_at,u.email FROM household_members m JOIN users u ON u.id=m.user_id WHERE m.household_id=? ORDER BY m.created_at,m.user_id', householdId) };
  }
  async invite(userId: string, householdId: string, body: unknown) {
    const input = inviteBody.parse(body);
    return await this.db.transaction(async () => {
      await this.owner(userId, householdId);
      const existing = await this.db.get('SELECT m.user_id FROM household_members m JOIN users u ON u.id=m.user_id WHERE m.household_id=? AND u.email=?', householdId, input.email);
      if (existing) fail(409, 'ALREADY_MEMBER', '该用户已是家庭成员');
      const token = newToken(), id = this.db.id(), expires = new Date(this.db.clock().getTime() + 7 * 86400_000).toISOString();
      await this.db.run('INSERT INTO household_invitations VALUES (?,?,?,?,?,?,?,?,?)', id, householdId, input.email, input.role, hashToken(token), userId, expires, null, this.db.now());
      await this.db.audit(userId, 'household.invite', householdId, { invitation_id: id, role: input.role });
      return { id, household_id: householdId, email: input.email, role: input.role, token, expires_at: expires };
    });
  }
  async accept(userId: string, token: string) {
    return await this.db.transaction(async () => {
      const invite = await this.db.get('SELECT * FROM household_invitations WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?', hashToken(token), this.db.now());
      if (!invite) fail(404, 'INVITATION_NOT_FOUND', '邀请不存在、已接受或已过期');
      const user = (await this.db.get('SELECT email FROM users WHERE id=?', userId))!;
      if (user.email !== invite.email) fail(403, 'INVITATION_EMAIL_MISMATCH', '请使用被邀请的邮箱接受邀请');
      if ((await this.db.get('SELECT 1 FROM household_members WHERE household_id=? AND user_id=?', invite.household_id, userId))) fail(409, 'ALREADY_MEMBER', '该用户已是家庭成员');
      await this.db.run('INSERT INTO household_members VALUES (?,?,?,?)', invite.household_id, userId, invite.role, this.db.now());
      await this.db.run('UPDATE household_invitations SET accepted_at=? WHERE id=?', this.db.now(), invite.id);
      await this.db.audit(userId, 'household.invitation.accept', invite.household_id, { invitation_id: invite.id, role: invite.role });
      return { household_id: invite.household_id, user_id: userId, role: invite.role };
    });
  }
  async changeMember(userId: string, householdId: string, targetId: string, body: unknown) {
    const input = memberBody.parse(body);
    return await this.db.transaction(async () => {
      await this.owner(userId, householdId);
      const target = await this.db.get('SELECT * FROM household_members WHERE household_id=? AND user_id=?', householdId, targetId);
      if (!target) fail(404, 'NOT_FOUND', '成员不存在');
      if (target.role === 'owner') fail(409, 'OWNER_IMMUTABLE', '不能修改家庭所有者角色');
      await this.db.run('UPDATE household_members SET role=? WHERE household_id=? AND user_id=?', input.role, householdId, targetId);
      await this.db.audit(userId, 'household.member.role', householdId, { user_id: targetId, role: input.role });
      return { household_id: householdId, user_id: targetId, role: input.role };
    });
  }
  async revokeMember(userId: string, householdId: string, targetId: string) {
    return await this.db.transaction(async () => {
      await this.owner(userId, householdId);
      const target = await this.db.get('SELECT * FROM household_members WHERE household_id=? AND user_id=?', householdId, targetId);
      if (!target) fail(404, 'NOT_FOUND', '成员不存在');
      if (target.role === 'owner') fail(409, 'OWNER_IMMUTABLE', '不能移除家庭所有者');
      await this.db.run('DELETE FROM household_members WHERE household_id=? AND user_id=?', householdId, targetId);
      // Pending invitations must not silently restore revoked access.
      await this.db.run('DELETE FROM household_invitations WHERE household_id=? AND email=(SELECT email FROM users WHERE id=?) AND accepted_at IS NULL', householdId, targetId);
      await this.db.audit(userId, 'household.member.revoke', householdId, { user_id: targetId });
      return { revoked: true };
    });
  }
  async pets(userId: string) {
    const rows = await this.db.all('SELECT p.* FROM pets p JOIN household_members m ON m.household_id=p.household_id WHERE m.user_id=? ORDER BY p.created_at,p.id', userId);
    return { items: await Promise.all(rows.map(row => presentPet(this.db, row))) };
  }
  async createPet(userId: string, body: unknown, key?: string) {
    const input = newPetBody.parse(body);
    return this.db.transaction(async () => {
      await this.db.household(userId, input.household_id, true);
      return this.db.idempotent(userId, 'POST /pets', key, input, async () => {
        const id = this.db.id(), now = this.db.now();
        await this.db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', id, input.household_id, input.name, input.species, input.breed ?? null, input.birth_date ?? null, input.weight_kg ?? null, now, now);
        if (input.timezone !== undefined) await this.db.run('INSERT INTO pet_settings VALUES (?,?)', id, input.timezone);
        await this.db.audit(userId, 'pet.create', id);
        return await presentPet(this.db, (await this.db.get('SELECT * FROM pets WHERE id=?', id))!);
      });
    });
  }
  async getPet(userId: string, petId: string) { return await presentPet(this.db, (await this.db.pet(userId, petId))); }
  async updatePet(userId: string, petId: string, body: unknown) {
    const input = patchPetBody.parse(body);
    if (!Object.keys(input).length) fail(400, 'EMPTY_UPDATE', '请提供至少一个待修改字段');
    return await this.db.transaction(async () => {
      const current = await this.db.pet(userId, petId, true), next: Row = { ...current, ...input };
      await this.db.run('UPDATE pets SET name=?,species=?,breed=?,birth_date=?,weight_kg=?,updated_at=? WHERE id=?', next.name, next.species, next.breed, next.birth_date, next.weight_kg, this.db.now(), petId);
      if (input.timezone !== undefined) await this.db.run('INSERT INTO pet_settings VALUES (?,?) ON CONFLICT(pet_id) DO UPDATE SET timezone=excluded.timezone', petId, input.timezone);
      await this.db.audit(userId, 'pet.update', petId, { fields: Object.keys(input) });
      return await presentPet(this.db, (await this.db.get('SELECT * FROM pets WHERE id=?', petId))!);
    });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly identity: IdentityService, private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>('isPublic', [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization as string | undefined;
    if (!authorization || !/^Bearer [A-Za-z0-9_-]+$/i.test(authorization)) fail(401, 'UNAUTHENTICATED', '请提供 Bearer 登录令牌');
    request.userId = (await this.identity.userFromAccess(authorization.slice(7)));
    return true;
  }
}

@ApiTags('账号')
@Controller('auth')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Public() @Post('register') @JsonBody(registration)
  register(@Body() body: unknown) { return this.identity.register(body); }
  @Public() @Post('login') @HttpCode(200) @JsonBody(credentials)
  login(@Body() body: unknown) { return this.identity.login(body); }
  @Public() @Post('refresh') @HttpCode(200) @JsonBody(refreshBody)
  refresh(@Body() body: unknown) { return this.identity.refresh(body); }
  @ApiBearerAuth() @Get('me')
  me(@CurrentUser() userId: string) { return this.identity.me(userId); }
  @ApiBearerAuth() @Post('logout') @HttpCode(200)
  logout(@Headers('authorization') authorization: string) { return this.identity.logout(authorization); }
}

@ApiTags('家庭共享') @ApiBearerAuth()
@Controller()
export class HouseholdController {
  constructor(private readonly identity: IdentityService) {}
  @Get('households')
  list(@CurrentUser() userId: string) { return this.identity.households(userId); }
  @Patch('households/:id') @JsonBody(householdBody)
  update(@CurrentUser() userId: string, @Param('id') id: string, @Body() body: unknown) { return this.identity.updateHousehold(userId, id, body); }
  @Get('households/:id/members')
  members(@CurrentUser() userId: string, @Param('id') id: string) { return this.identity.members(userId, id); }
  @Post('households/:id/invitations') @JsonBody(inviteBody)
  invite(@CurrentUser() userId: string, @Param('id') id: string, @Body() body: unknown) { return this.identity.invite(userId, id, body); }
  @Post('invitations/:token/accept') @HttpCode(200)
  accept(@CurrentUser() userId: string, @Param('token') token: string) { return this.identity.accept(userId, token); }
  @Patch('households/:id/members/:userId') @JsonBody(memberBody)
  change(@CurrentUser() userId: string, @Param('id') id: string, @Param('userId') targetId: string, @Body() body: unknown) { return this.identity.changeMember(userId, id, targetId, body); }
  @Delete('households/:id/members/:userId')
  revoke(@CurrentUser() userId: string, @Param('id') id: string, @Param('userId') targetId: string) { return this.identity.revokeMember(userId, id, targetId); }
}

@ApiTags('宠物') @ApiBearerAuth()
@Controller('pets')
export class PetController {
  constructor(private readonly identity: IdentityService) {}
  @Get()
  list(@CurrentUser() userId: string) { return this.identity.pets(userId); }
  @Post() @JsonBody(newPetBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  create(@CurrentUser() userId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) { return this.identity.createPet(userId, body, key); }
  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) { return this.identity.getPet(userId, id); }
  @Patch(':id') @JsonBody(patchPetBody)
  patch(@CurrentUser() userId: string, @Param('id') id: string, @Body() body: unknown) { return this.identity.updatePet(userId, id, body); }
}
