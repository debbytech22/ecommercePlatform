import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationProvider,
  NotificationProviderRequest,
  NotificationProviderResult,
} from '../notification-provider.interface';

@Injectable()
export class EmailProvider implements NotificationProvider {
  private readonly logger = new Logger(EmailProvider.name);

  async send(request: NotificationProviderRequest): Promise<NotificationProviderResult> {
    this.logger.log(
      JSON.stringify({
        event: 'notification.email.send',
        notificationId: request.notificationId,
        to: request.recipientAddress,
        subject: request.subject,
      }),
    );
    // TODO: integrate SMTP / SES
    return { providerMessageId: null };
  }
}
