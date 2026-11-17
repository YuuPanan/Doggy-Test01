import { Body, Controller, Get, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { settings } from './config';
import { Db } from './db';
import { fail, JsonBody, Public } from './http';
import { envelopeSchema, TelemetryService } from './telemetry';

export function verifyWebhook(rawBody: Buffer, timestamp: string, signature: string, secret: string, nowMs: number): boolean {
  if (!/^\d{10,12}$/.test(timestamp) || !/^[a-f\d]{64}$/i.test(signature)) return false;
  if (Math.abs(nowMs - Number(timestamp) * 1000) > 300_000) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

@ApiTags('数据接入')
@Controller('integrations')
export class IntegrationController {
  constructor(private readonly telemetry: TelemetryService, private readonly db: Db) {}

  @Get('status') @ApiBearerAuth()
  status() {
    const config = settings();
    return {
      mode: config.DATA_MODE,
      telemetry_endpoint: '/api/v1/ingest/events',
      vendor_endpoint: config.DATA_MODE === 'api' ? '/api/v1/integrations/vendor/events' : null,
      vendor_configured: config.DATA_MODE === 'api' && Boolean(config.VENDOR_WEBHOOK_SECRET),
      push_configured: Boolean(config.PUSH_WEBHOOK_URL && config.PUSH_WEBHOOK_TOKEN),
      push_mode: config.DATA_MODE === 'offline' ? 'mock' : 'webhook',
    };
  }

  @Public() @Post('vendor/events') @HttpCode(202) @JsonBody(envelopeSchema)
  @ApiHeader({ name: 'x-doogy-timestamp', required: true, description: 'Unix 时间戳（秒），允许与服务端相差 5 分钟' })
  @ApiHeader({ name: 'x-doogy-signature', required: true, description: 'HMAC-SHA256(secret, timestamp + "." + 原始请求体)，64 位十六进制' })
  ingest(@Req() request: RawBodyRequest<Request>, @Body() body: unknown, @Headers('x-doogy-timestamp') timestamp = '', @Headers('x-doogy-signature') signature = '') {
    const config = settings();
    if (config.DATA_MODE !== 'api') fail(404, 'INTEGRATION_DISABLED', '供应商接口仅在 api 模式启用');
    if (!config.VENDOR_WEBHOOK_SECRET) fail(503, 'INTEGRATION_NOT_CONFIGURED', '尚未配置供应商 Webhook 密钥');
    if (!request.rawBody) fail(400, 'RAW_BODY_REQUIRED', 'Webhook 必须携带原始 JSON 请求体');
    if (!verifyWebhook(request.rawBody, timestamp, signature, config.VENDOR_WEBHOOK_SECRET, this.db.clock().getTime())) fail(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook 签名或时间戳无效');
    return this.telemetry.ingestVendor(body);
  }
}
