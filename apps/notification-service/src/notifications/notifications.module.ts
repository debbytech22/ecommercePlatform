import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationAttemptEntity } from './entities/notification-attempt.entity';
import { NotificationEntity } from './entities/notification.entity';
import { NotificationPreferenceEntity } from './entities/notification-preference.entity';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { InboxEventEntity } from '../inbox/entities/inbox-event.entity';
import { ProvidersModule } from '../providers/providers.module';
import { NotificationMetricsService } from '../common/notification-metrics.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity,
      NotificationAttemptEntity,
      NotificationPreferenceEntity,
      InboxEventEntity,
    ]),
    ProvidersModule,
  ],
  providers: [
    NotificationsService,
    NotificationsRepository,
    NotificationDeliveryService,
    NotificationMetricsService,
  ],
  exports: [
    NotificationsService,
    NotificationsRepository,
    NotificationDeliveryService,
    NotificationMetricsService,
  ],
})
export class NotificationsModule {}
