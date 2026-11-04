import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailProviderService } from './email/email-provider.service';
import { SmsProviderService } from './sms/sms-provider.service';
import { PushProviderService } from './push/push-provider.service';
import { EMAIL_PROVIDER, SMS_PROVIDER, PUSH_PROVIDER } from './notification-provider.interface';

@Module({
  imports: [ConfigModule],
  providers: [
    { provide: EMAIL_PROVIDER, useClass: EmailProviderService },
    { provide: SMS_PROVIDER, useClass: SmsProviderService },
    { provide: PUSH_PROVIDER, useClass: PushProviderService },
  ],
  exports: [EMAIL_PROVIDER, SMS_PROVIDER, PUSH_PROVIDER],
})
export class ProvidersModule {}
