import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Request, Response, NextFunction } from 'express';
import { Db } from './db';
import { ApiErrors, Public } from './http';
import { AuthGuard, HouseholdController, IdentityController, IdentityService, PetController } from './identity';
import { DevicesController, DevicesService } from './devices';
import { FencesController, FencesService } from './fences';
import { NotificationController, NotificationService } from './notifications';
import { TelemetryController, TelemetryService } from './telemetry';
import { CareAttachmentsController, CareController, CareService } from './care';
import { IntegrationController } from './integrations';
import { settings } from './config';
import { SafetyController, SafetyService } from './safety';
import { ReportingController, ReportingService } from './reporting';
import { SharesController, SharesService } from './shares';
import { SupportAdminController, SupportController, SupportService } from './support';
import { ObservationsController, ObservationsService } from './observations';
import { OperationsController, OperationsService } from './operations';
import { DeviceCredentialsController, DeviceCredentialsService } from './device-credentials';
import { AccountExportController, AccountExportService } from './account-export';
import { PrivacyController, PrivacyService } from './privacy';
import { RetentionController, RetentionService } from './retention';
import { InventoryRetentionController, InventoryRetentionService } from './inventory-retention';
import { demoAccounts } from './demo-accounts';

@Controller()
class HealthController {
  constructor(@Inject(Db) readonly db: Db) {}
  @Public() @Get('health') async health() { await this.db.get('SELECT 1'); const demo = process.env.DOOGY_DEMO === '1'; return { status: 'ok', mode: settings().DATA_MODE, database: this.db.driver, demo, ...(demo ? { demo_accounts: demoAccounts } : {}), time: this.db.now() }; }
}

export async function createApp(options: { db?: Db; quiet?: boolean } = {}) {
  settings();
  const db = options.db ?? await Db.open();
  @Module({
    controllers: [HealthController, IdentityController, HouseholdController, PetController, DevicesController, FencesController,
      TelemetryController, NotificationController, CareController, CareAttachmentsController, IntegrationController, SafetyController, ReportingController,
      SharesController, SupportController, SupportAdminController, ObservationsController, OperationsController, DeviceCredentialsController, AccountExportController, PrivacyController, RetentionController, InventoryRetentionController],
    providers: [{ provide: Db, useValue: db }, IdentityService, DevicesService, FencesService, NotificationService, TelemetryService, CareService, SafetyService, ReportingService,
      SharesService, SupportService, ObservationsService, OperationsService, DeviceCredentialsService, AccountExportService, PrivacyService, RetentionService, InventoryRetentionService,
      { provide: APP_GUARD, useClass: AuthGuard }]
  })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: options.quiet ? false : ['log', 'error', 'warn'] });
  app.setGlobalPrefix('api/v1');
  app.use((_: Request, response: Response, next: NextFunction) => { response.setHeader('x-request-id', randomUUID()); next(); });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === '/app') response.redirect('/app/');
    else next();
  });
  app.useStaticAssets(resolve(__dirname, '../../web'), { prefix: '/app/' });
  app.useGlobalFilters(new ApiErrors());
  const config = new DocumentBuilder().setTitle('DOOGY Backend').setDescription('本地离线 / API 接入共用业务 API；设备与供应商适配说明见 docs/device-api.md')
    .setVersion('0.1.0').addBearerAuth().build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'openapi.json' });
  await app.init();
  return app;
}
