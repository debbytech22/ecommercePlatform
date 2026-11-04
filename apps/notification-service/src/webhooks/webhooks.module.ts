import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailWebhookController } from './email-webhook.controller';
import { SmsWebhookController } from './sms-webhook.controller';

@Module({
  imports: [ConfigModule],
  controllers: [EmailWebhookController, SmsWebhookController],
})
export class WebhooksModule {}
