import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationEntity } from '../notifications/entities/notification.entity';
import { NotificationStatus } from '../notifications/notification-status.enum';

interface EmailWebhookEvent {
  messageId: string;
  event: 'delivered' | 'bounced' | 'complained' | string;
}

@Controller('webhooks/email')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(private readonly dataSource: DataSource) {}

  @Post()
  @HttpCode(200)
  async handle(@Body() body: unknown): Promise<{ received: true }> {
    const events = Array.isArray(body) ? body : [body];
    for (const item of events as EmailWebhookEvent[]) {
      if (typeof item?.messageId !== 'string') continue;
      await this.processEvent(item);
    }
    return { received: true };
  }

  private async processEvent(item: EmailWebhookEvent): Promise<void> {
    const repo = this.dataSource.getRepository(NotificationEntity);
    const notification = await repo.findOne({
      where: { providerMessageId: item.messageId },
    });
    if (!notification) return;

    if (item.event === 'bounced' || item.event === 'complained') {
      await repo.update(
        { id: notification.id },
        { status: NotificationStatus.FAILED, lastError: `Provider event: ${item.event}` },
      );
      this.logger.warn(
        JSON.stringify({
          event: 'notification.email.webhook_failure',
          notificationId: notification.id,
          providerEvent: item.event,
        }),
      );
    } else if (item.event === 'delivered') {
      await repo.update(
        { id: notification.id },
        { status: NotificationStatus.SENT, sentAt: new Date() },
      );
    }
  }
}
