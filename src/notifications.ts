import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { settings } from './config';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody, pageQuery } from './http';

const preferencesBody = z.object({ geofence: z.boolean().optional(), battery: z.boolean().optional(), offline: z.boolean().optional(), location: z.boolean().optional() });
const tokenBody = z.object({ platform: z.enum(['ios', 'android']), token: z.string().min(8).max(4096) });
const notificationQuery = pageQuery.extend({ unread: z.enum(['true', 'false']).optional() });
const category = (type: string) => /battery/.test(type) ? 'battery' : /offline/.test(type) ? 'offline' : /location/.test(type) ? 'location' : 'geofence';
const visibleSql = `SELECT n.*,e.type,e.pet_id FROM notifications n JOIN safety_events e ON e.id=n.event_id
  JOIN pets p ON p.id=e.pet_id JOIN household_members m ON m.household_id=p.household_id AND m.user_id=n.user_id`;

@Injectable()
export class NotificationService {
  constructor(private readonly db: Db) {}

  async preferences(userId: string) {
    const row = await this.db.get('SELECT * FROM notification_preferences WHERE user_id=?', userId);
    return { geofence: row ? !!row.geofence : true, battery: row ? !!row.battery : true, offline: row ? !!row.offline : true, location: row ? !!row.location : true };
  }

  async updatePreferences(userId: string, body: unknown) {
    const input = preferencesBody.parse(body);
    return this.db.transaction(async () => {
      if (!await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', userId)) fail(401, 'UNAUTHENTICATED', '账号不存在或已注销');
      const values = { ...(await this.preferences(userId)), ...input };
      await this.db.run(`INSERT INTO notification_preferences VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
        geofence=excluded.geofence,battery=excluded.battery,offline=excluded.offline,location=excluded.location`,
      userId, Number(values.geofence), Number(values.battery), Number(values.offline), Number(values.location));
      return values;
    });
  }

  async enqueue(eventId: string) {
    const event = await this.db.get('SELECT e.*,p.household_id FROM safety_events e JOIN pets p ON p.id=e.pet_id WHERE e.id=?', eventId);
    if (!event) fail(404, 'NOT_FOUND', '安全事件不存在');
    for (const member of (await this.db.all('SELECT user_id FROM household_members WHERE household_id=?', event.household_id))) {
      if (!(await this.preferences(member.user_id))[category(event.type)]) continue;
      await this.db.run(`INSERT INTO notifications(id,user_id,event_id,next_attempt_at,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,event_id) DO NOTHING`, this.db.id(), member.user_id, eventId, this.db.now(), this.db.now());
    }
  }

  async list(userId: string, query: unknown) {
    const input = notificationQuery.parse(query);
    const cursor = input.cursor ? (await this.db.get(`${visibleSql} WHERE n.id=? AND n.user_id=?`, input.cursor, userId)) : undefined;
    if (input.cursor && !cursor) fail(400, 'INVALID_CURSOR', '分页游标无效');
    const values: (string | number)[] = [userId];
    let sql = `${visibleSql} WHERE n.user_id=?`;
    if (input.unread !== undefined) sql += input.unread === 'true' ? ' AND n.read_at IS NULL' : ' AND n.read_at IS NOT NULL';
    if (cursor) { sql += ' AND (n.created_at<? OR (n.created_at=? AND n.id<?))'; values.push(cursor.created_at, cursor.created_at, cursor.id); }
    values.push(input.limit + 1);
    const rows = await this.db.all(`${sql} ORDER BY n.created_at DESC,n.id DESC LIMIT ?`, ...values);
    return { items: rows.slice(0, input.limit).map(({ lease_until, ...row }) => row), next_cursor: rows.length > input.limit ? rows[input.limit - 1].id : null };
  }

  async markRead(userId: string, id: string) {
    return this.db.transaction(async () => {
      await this.findVisible(userId, id);
      await this.db.run('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?', this.db.now(), id);
      return { id, read_at: (await this.db.get('SELECT read_at FROM notifications WHERE id=?', id))!.read_at };
    });
  }

  async retryDead(userId: string, id: string) {
    return this.db.transaction(async () => {
      const notification = await this.findVisible(userId, id);
      if (notification.status !== 'dead') fail(409, 'NOT_RETRYABLE', '只有失败终止的通知可以重新排队');
      await this.db.run("UPDATE notifications SET status='pending',retry_count=0,error=NULL,next_attempt_at=?,lease_until=NULL WHERE id=?", this.db.now(), id);
      return { id, status: 'pending' };
    });
  }

  async registerToken(userId: string, body: unknown) {
    const input = tokenBody.parse(body);
    return this.db.transaction(async () => {
      if (!await this.db.get('SELECT id FROM users WHERE id=? AND closed_at IS NULL', userId)) fail(401, 'UNAUTHENTICATED', '账号不存在或已注销');
      const existing = await this.db.get('SELECT id FROM push_tokens WHERE token=?', input.token);
      const id = existing?.id ?? this.db.id();
      await this.db.run(`INSERT INTO push_tokens VALUES (?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,created_at=excluded.created_at`,
        id, userId, input.platform, input.token, this.db.now());
      return { id, platform: input.platform };
    });
  }

  async removeToken(userId: string, id: string) {
    if (!(await this.db.run('DELETE FROM push_tokens WHERE id=? AND user_id=?', id, userId)).changes) fail(404, 'NOT_FOUND', '推送设备不存在');
    return { deleted: true };
  }

  private async findVisible(userId: string, id: string) {
    const notification = await this.db.get(`${visibleSql} WHERE n.id=? AND n.user_id=?`, id, userId);
    if (!notification) fail(404, 'NOT_FOUND', '通知不存在');
    return notification;
  }

  protected async deliver(notification: Row, tokens: Row[]): Promise<string> {
    const config = settings();
    const response = await fetch(config.PUSH_WEBHOOK_URL!, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.PUSH_WEBHOOK_TOKEN}`, 'Idempotency-Key': notification.id },
      body: JSON.stringify({ notification_id: notification.id, event_id: notification.event_id, type: notification.type, user_id: notification.user_id, tokens: tokens.map(t => ({ platform: t.platform, token: t.token })) }),
    });
    if (!response.ok) throw new Error(`PUSH_HTTP_${response.status}`);
    const result = z.object({ message_id: z.string().min(1).max(300) }).safeParse(await response.json());
    if (!result.success) throw new Error('PUSH_INVALID_RESPONSE');
    return result.data.message_id;
  }

  async dispatch(limit = 100): Promise<number> {
    const config = settings();
    const simulate = config.DATA_MODE === 'offline';
    if (!simulate && (!config.PUSH_WEBHOOK_URL || !config.PUSH_WEBHOOK_TOKEN)) return 0;
    if (!simulate) {
      const url = new URL(config.PUSH_WEBHOOK_URL!);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Push webhook requires HTTPS, except localhost');
    }
    let processed = 0;
    while (processed < limit) {
      const notification = await this.db.transaction(async () => {
        await this.db.run("UPDATE notifications SET status='pending',lease_until=NULL WHERE status='processing' AND lease_until<=?", this.db.now());
        const next = await this.db.get(`SELECT n.*,e.type FROM notifications n JOIN safety_events e ON e.id=n.event_id
          WHERE n.status='pending' AND n.next_attempt_at<=? ORDER BY n.created_at,n.id LIMIT 1`, this.db.now());
        if (!next) return undefined;
        const lease = new Date(this.db.clock().getTime() + 30_000).toISOString();
        await this.db.run("UPDATE notifications SET status='processing',lease_until=? WHERE id=?", lease, next.id);
        next.lease_until = lease;
        return next;
      });
      if (!notification) break;
      const accessible = await this.db.get(`${visibleSql} WHERE n.id=?`, notification.id);
      const enabled = (await this.preferences(notification.user_id))[category(notification.type)];
      const tokens = await this.db.all('SELECT platform,token FROM push_tokens WHERE user_id=?', notification.user_id);
      if (!accessible || !enabled || (!simulate && tokens.length === 0)) {
        await this.db.run("UPDATE notifications SET status='skipped',error=?,lease_until=NULL WHERE id=? AND status='processing' AND lease_until=?", !accessible ? 'ACCESS_REVOKED' : !enabled ? 'PREFERENCE_DISABLED' : 'NO_PUSH_TOKENS', notification.id, notification.lease_until);
        processed++;
        continue;
      }
      try {
        const providerId = simulate ? `mock:${notification.id}` : await this.deliver(notification, tokens);
        await this.db.run("UPDATE notifications SET status=?,provider_message_id=?,sent_at=?,error=NULL,lease_until=NULL WHERE id=? AND status='processing' AND lease_until=?",
          simulate ? 'simulated' : 'sent', providerId, this.db.now(), notification.id, notification.lease_until);
      } catch (error) {
        const attempts = notification.retry_count + 1;
        // Provider response bodies can contain secrets; persist only a small known error code.
        const reason = error instanceof Error && /^PUSH_(HTTP_\d{3}|INVALID_RESPONSE)$/.test(error.message) ? error.message : 'PUSH_DELIVERY_FAILED';
        await this.db.run("UPDATE notifications SET status=?,retry_count=?,next_attempt_at=?,error=?,lease_until=NULL WHERE id=? AND status='processing' AND lease_until=?",
          attempts >= 5 ? 'dead' : 'pending', attempts, new Date(this.db.clock().getTime() + Math.min(3600, 2 ** attempts) * 1000).toISOString(), reason, notification.id, notification.lease_until);
      }
      processed++;
    }
    return processed;
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}
  @Get('notifications') list(@CurrentUser() user: string, @Query() query: unknown) { return this.notifications.list(user, query); }
  @Patch('notifications/:id/read') markRead(@CurrentUser() user: string, @Param('id') id: string) { return this.notifications.markRead(user, id); }
  @Post('notifications/:id/retry') retry(@CurrentUser() user: string, @Param('id') id: string) { return this.notifications.retryDead(user, id); }
  @Get('notification-preferences') preferences(@CurrentUser() user: string) { return this.notifications.preferences(user); }
  @Patch('notification-preferences') @JsonBody(preferencesBody) update(@CurrentUser() user: string, @Body() body: unknown) { return this.notifications.updatePreferences(user, body); }
  @Post('push-tokens') @JsonBody(tokenBody) register(@CurrentUser() user: string, @Body() body: unknown) { return this.notifications.registerToken(user, body); }
  @Delete('push-tokens/:id') remove(@CurrentUser() user: string, @Param('id') id: string) { return this.notifications.removeToken(user, id); }
}
