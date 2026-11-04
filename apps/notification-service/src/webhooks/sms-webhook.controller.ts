import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { NotificationEntity } from '../notifications/entities/notification.entity';
import { NotificationStatus } from '../notifications/notification-status.enum';

const STATUS_MAP: Record<string, NotificationStatus> = {
  delivered:   NotificationStatus.DELIVERED,
  failed:      NotificationStatus.FAILED,
  undelivered: NotificationStatus.BOUNCED,
  rejected:    NotificationStatus.REJECTED,
};

interface SmsWebhookEvent {
  messageId: string;
  status: string;
  errorCode?: string;
}

@Controller('webhooks/sms')
export class SmsWebhookController {
  private readonly logger = new Logger(SmsWebhookController.name);
  private readonly secret: string;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('SMS_WEBHOOK_SECRET');
  }

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    this.verifySignature(req.rawBody, signature);
    const events = Array.isArray(body) ? body : [body];
    for (const item of events as SmsWebhookEvent[]) {
      if (typeof item?.messageId !== 'string') continue;
      await this.processEvent(item);
    }
    return { received: true };
  }

  private verifySignature(rawBody: Buffer | undefined, signature: string | undefined): void {
    if (!rawBody || !signature) throw new BadRequestException('Missing signature');
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new BadRequestException('Invalid signature');
    }
  }

  private async processEvent(item: SmsWebhookEvent): Promise<void> {
    const repo = this.dataSource.getRepository(NotificationEntity);
    const notification = await repo.findOne({ where: { providerMessageId: item.messageId } });
    if (!notification) return;

    const newStatus = STATUS_MAP[item.status];
    if (!newStatus) return;

    if (notification.status === newStatus) return;

    const update: Partial<NotificationEntity> = { status: newStatus };
    if (newStatus === NotificationStatus.DELIVERED) {
      update.sentAt = new Date();
    } else {
      update.lastError = `provider_status:${item.status}${item.errorCode ? `:${item.errorCode}` : ''}`;
    }

    await repo.update({ id: notification.id }, update);

    this.logger.log(JSON.stringify({
      event: 'notification.sms.webhook',
      notificationId: notification.id,
      providerMessageId: item.messageId,
      providerStatus: item.status,
      errorCode: item.errorCode ?? null,
      newStatus,
    }));
  }
}
