import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { MessagingModule } from './messaging/messaging.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxModule } from './outbox/outbox.module';
import { TemplatesModule } from './templates/templates.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { NotificationWorker } from './workers/notification.worker';
import { NotificationRecoveryWorker } from './workers/notification-recovery.worker';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DatabaseModule,
    NotificationsModule,
    TemplatesModule,
    MessagingModule,
    OutboxModule,
    WebhooksModule,
  ],
  providers: [NotificationWorker, NotificationRecoveryWorker],
})
export class NotificationServiceModule {}
