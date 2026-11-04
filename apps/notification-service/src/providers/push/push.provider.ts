import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationProvider,
  NotificationProviderRequest,
  NotificationProviderResult,
} from '../notification-provider.interface';

@Injectable()
export class PushProvider implements NotificationProvider {
  private readonly logger = new Logger(PushProvider.name);

  async send(request: NotificationProviderRequest): Promise<NotificationProviderResult> {
    this.logger.log(
      JSON.stringify({
        event: 'notification.push.send',
        notificationId: request.notificationId,
        to: request.recipientAddress,
      }),
    );
    // TODO: integrate FCM / APNs
    return { providerMessageId: null };
  }
}
