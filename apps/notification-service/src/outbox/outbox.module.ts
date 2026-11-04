import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OutboxPublisherService } from './outbox-publisher.service';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [ConfigModule, MessagingModule],
  providers: [OutboxPublisherService],
})
export class OutboxModule {}
