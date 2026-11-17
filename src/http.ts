import { applyDecorators, ArgumentsHost, Catch, createParamDecorator, ExceptionFilter, ExecutionContext, HttpException, SetMetadata } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Request, Response } from 'express';

export const Public = () => SetMetadata('isPublic', true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): string => (ctx.switchToHttp().getRequest() as Request & { userId: string }).userId);
export function fail(status: number, code: string, message: string): never { throw new HttpException({ code, message }, status); }
export const JsonBody = (schema: z.ZodType) => applyDecorators(ApiBody({ schema: z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' }) as any }));
export const dateTime = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional() });
export function boundedRange(from: string | undefined, to: string | undefined, now: Date) {
  // An implicit upper bound includes samples at the clock's current millisecond.
  const end = to ? dateTime.parse(to) : new Date(now.getTime() + 1).toISOString();
  const start = from ? dateTime.parse(from) : new Date(Date.parse(end) - 86400_000).toISOString();
  if (start >= end) fail(400, 'INVALID_RANGE', 'from 必须早于 to');
  if (Date.parse(end) - Date.parse(start) > 31 * 86400_000) fail(400, 'RANGE_TOO_LARGE', '单次查询时间范围最多为31天');
  return { from: start, to: end };
}
export function page<T extends RowWithId>(rows: T[], limit: number) {
  return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
}
type RowWithId = { id: string };

@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = response.getHeader('x-request-id') ?? randomUUID();
    let status = 500;
    let detail: Record<string, unknown> = { code: 'INTERNAL_ERROR', message: '服务内部错误' };
    const cause = error instanceof HttpException ? error.cause : error;
    if (cause && typeof cause === 'object' && 'type' in cause && cause.type === 'entity.parse.failed') {
      status = 400;
      detail = { code: 'INVALID_JSON', message: '请求体不是有效 JSON' };
    } else if (cause && typeof cause === 'object' && 'type' in cause && cause.type === 'entity.too.large') {
      status = 413;
      detail = { code: 'BODY_TOO_LARGE', message: '请求体超过大小限制' };
    } else if (error instanceof z.ZodError) {
      status = 400;
      detail = { code: 'VALIDATION_ERROR', message: '请求参数不正确', issues: error.issues.map(i => ({ path: i.path, message: i.message })) };
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const body = error.getResponse();
      detail = typeof body === 'string' ? { code: `HTTP_${status}`, message: body } : { code: `HTTP_${status}`, ...body };
    } else {
      // Do not log request bodies, tokens or precise coordinates.
      console.error(error instanceof Error ? error.message : 'Unhandled error');
    }
    response.status(status).json({ ...detail, request_id: requestId });
  }
}
