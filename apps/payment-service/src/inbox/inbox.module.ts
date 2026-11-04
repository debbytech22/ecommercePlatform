import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxEventEntity } from './entities/inbox-event.entity';
import { InboxService } from './inbox.service';

@Module({
  imports: [TypeOrmModule.forFeature([InboxEventEntity])],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
