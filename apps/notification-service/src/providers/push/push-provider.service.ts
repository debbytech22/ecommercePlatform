import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PushProvider, SendPushRequest, SendPushResult } from '../notification-provider.interface';
import { NotificationProviderError } from '../notification-provider.interface';

@Injectable()
export class PushProviderService implements PushProvider, OnModuleInit {
  private readonly logger = new Logger(PushProviderService.name);
  readonly providerName = 'fcm-stub';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const serviceAccountKey = this.config.get<string>('FCM_SERVICE_ACCOUNT_KEY');
    if (!serviceAccountKey) {
      this.logger.warn(
        'FCM_SERVICE_ACCOUNT_KEY is not set — push delivery will be no-op until configured',
      );
    }
  }

  async sendPush(request: SendPushRequest): Promise<SendPushResult> {
    this.logger.log(
      JSON.stringify({
        event: 'notification.push.send_attempt',
        notificationId: request.notificationId,
        // device token is sensitive — do not log full value
        deviceTokenPrefix: request.deviceToken.slice(0, 8),
        idempotencyKey: request.idempotencyKey,
        provider: this.providerName,
      }),
    );

    const serviceAccountKey = this.config.get<string>('FCM_SERVICE_ACCOUNT_KEY');
    if (!serviceAccountKey) {
      throw new NotificationProviderError(
        'FCM_SERVICE_ACCOUNT_KEY is not configured',
        'AUTHENTICATION',
        false,
      );
    }

    // TODO: replace with real FCM SDK call
    return { providerMessageId: null, providerName: this.providerName };
  }
}
