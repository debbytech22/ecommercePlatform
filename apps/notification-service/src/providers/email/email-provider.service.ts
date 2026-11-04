import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailProvider, SendEmailRequest, SendEmailResult } from '../notification-provider.interface';
import { NotificationProviderError } from '../notification-provider.interface';
import { redactAddress } from '../../common/utils/redaction.util';

@Injectable()
export class EmailProviderService implements EmailProvider, OnModuleInit {
  private readonly logger = new Logger(EmailProviderService.name);
  readonly providerName = 'ses-stub';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Validate required credentials at startup — fail fast rather than at send time
    const apiKey = this.config.get<string>('EMAIL_PROVIDER_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'EMAIL_PROVIDER_API_KEY is not set — email delivery will be no-op until configured',
      );
    }
  }

  async sendEmail(request: SendEmailRequest): Promise<SendEmailResult> {
    this.logger.log(
      JSON.stringify({
        event: 'notification.email.send_attempt',
        notificationId: request.notificationId,
        to: redactAddress(request.to),
        // subject logged without body — body may contain PII
        subject: request.subject,
        idempotencyKey: request.idempotencyKey,
        provider: this.providerName,
      }),
    );

    const apiKey = this.config.get<string>('EMAIL_PROVIDER_API_KEY');
    if (!apiKey) {
      throw new NotificationProviderError(
        'EMAIL_PROVIDER_API_KEY is not configured',
        'AUTHENTICATION',
        false,
      );
    }

    // TODO: replace with real SES / SendGrid SDK call
    // The idempotencyKey must be passed as the provider's deduplication ID
    // to prevent duplicate sends on timeout-then-retry scenarios.
    return { providerMessageId: null, providerName: this.providerName };
  }
}
