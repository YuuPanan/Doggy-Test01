import { z } from 'zod';

export function settings() {
  return z.object({
    DATA_MODE: z.enum(['offline', 'api']).default('offline'),
    DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
    DATABASE_URL: z.string().optional(),
    FRESH_SECONDS: z.coerce.number().positive().default(300),
    OFFLINE_SECONDS: z.coerce.number().positive().default(300),
    LOW_BATTERY_PCT: z.coerce.number().min(0).max(100).default(20),
    SUPPORT_ADMIN_USER_IDS: z.string().default(''),
    DEVICE_ADMIN_USER_IDS: z.string().default(''),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    MANAGED_BACKUP_ENABLED: z.enum(['true','false']).default('false').transform(value=>value==='true'),
    MANAGED_BACKUP_DIRECTORY: z.string().min(1).default('./data/managed-backups'),
    MANAGED_BACKUP_KEEP_COUNT: z.coerce.number().int().min(1).max(365).default(7),
    MANAGED_BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    PUSH_WEBHOOK_URL: z.url().optional(),
    PUSH_WEBHOOK_TOKEN: z.string().optional(),
    VENDOR_WEBHOOK_SECRET: z.string().min(24).optional()
  }).parse(process.env);
}
