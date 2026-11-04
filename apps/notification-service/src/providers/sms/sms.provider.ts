import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationProvider,
  NotificationProviderRequest,
  NotificationProviderResult,
} from '../notification-provider.interface';

@Injectable()
export class SmsProvider implements NotificationProvider {
  private readonly logger = new Logger(SmsProvider.name);

  async send(request: NotificationProviderRequest): Promise<NotificationProviderResult> {
    this.logger.log(
      JSON.stringify({
        event: 'notification.sms.send',
        notificationId: request.notificationId,
        to: request.recipientAddress,
      }),
    );
    // TODO: integrate Twilio / SNS
    return { providerMessageId: null };
  }
}
