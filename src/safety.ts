import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CurrentUser, fail, JsonBody } from './http';
import { presentLocation } from './location-quality';

const acknowledgeBody = z.object({ note: z.string().trim().max(1000).default('') });

export class SafetyService {
  constructor(@Inject(Db) readonly db: Db) {}
  private async authorized(user: string, id: string, write = false) {
    const event = (await this.db.get('SELECT * FROM safety_events WHERE id=?', id));
    if (!event) fail(404, 'NOT_FOUND', '安全事件不存在');
    await this.db.pet(user, event.pet_id, write);
    return event;
  }
  async detail(user: string, id: string): Promise<Row> {
    const { details_json, ...event } = (await this.authorized(user, id));
    const location = event.location_id ? (await this.db.get('SELECT * FROM locations WHERE id=? AND pet_id=?', event.location_id, event.pet_id)) : null;
    const acknowledgement = (await this.db.get('SELECT * FROM safety_acknowledgements WHERE event_id=?', id)) ?? null;
    return { ...event, details: JSON.parse(details_json), location: location ? (await presentLocation(this.db, location)) : null, acknowledgement,
      notifications: (await this.db.all(`SELECT id,status,retry_count,created_at,sent_at,read_at,error FROM notifications WHERE event_id=? AND user_id=? ORDER BY created_at,id`, id, user)),
      // A provider accepting a notification does not establish phone delivery.
      delivery_status: 'unknown' };
  }
  async acknowledge(user: string, id: string, raw: unknown, key?: string): Promise<Row> {
    const input = acknowledgeBody.parse(raw ?? {});
    return this.db.transaction(async () => {
      await this.authorized(user, id, true);
      return this.db.idempotent(user, `POST /safety-events/${id}/ack`, key, input, async () => {
        let acknowledgement = (await this.db.get('SELECT * FROM safety_acknowledgements WHERE event_id=?', id));
        if (!acknowledgement) {
          await this.db.run('INSERT INTO safety_acknowledgements VALUES (?,?,?,?)', id, user, this.db.now(), input.note);
          await this.db.audit(user, 'safety.acknowledged', id);
          acknowledgement = (await this.db.get('SELECT * FROM safety_acknowledgements WHERE event_id=?', id))!;
        }
        const event = (await this.db.get('SELECT status,closed_at FROM safety_events WHERE id=?', id))!;
        return { ...acknowledgement, event_status: event.status, event_closed_at: event.closed_at };
      });
    });
  }
}

@ApiTags('safety') @ApiBearerAuth()
@Controller('safety-events')
export class SafetyController {
  constructor(@Inject(SafetyService) readonly safety: SafetyService) {}
  @Get(':id') async detail(@CurrentUser() user: string, @Param('id') id: string) { return await this.safety.detail(user, id); }
  @Post(':id/ack') @JsonBody(acknowledgeBody) @ApiHeader({ name: 'Idempotency-Key', required: false })
  async acknowledge(@CurrentUser() user: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return await this.safety.acknowledge(user, id, body, key);
  }
}
