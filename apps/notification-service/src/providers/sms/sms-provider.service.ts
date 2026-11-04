import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SmsProvider, SendSmsRequest, SendSmsResult } from '../notification-provider.interface';
import { NotificationProviderError } from '../notification-provider.interface';
import { redactAddress } from '../../common/utils/redaction.util';

@Injectable()
export class SmsProviderService implements SmsProvider, OnModuleInit {
  private readonly logger = new Logger(SmsProviderService.name);
  readonly providerName = 'termii-stub';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const apiKey = this.config.get<string>('SMS_PROVIDER_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'SMS_PROVIDER_API_KEY is not set — SMS delivery will be no-op until configured',
      );
    }
  }

  async sendSms(request: SendSmsRequest): Promise<SendSmsResult> {
    this.logger.log(
      JSON.stringify({
        event: 'notification.sms.send_attempt',
        notificationId: request.notificationId,
        to: redactAddress(request.to),
        idempotencyKey: request.idempotencyKey,
        provider: this.providerName,
      }),
    );

    const apiKey = this.config.get<string>('SMS_PROVIDER_API_KEY');
    if (!apiKey) {
      throw new NotificationProviderError(
        'SMS_PROVIDER_API_KEY is not configured',
        'AUTHENTICATION',
        false,
      );
    }

    // TODO: replace with real Termii / Africa's Talking SDK call
    return { providerMessageId: null, providerName: this.providerName };
  }
}
