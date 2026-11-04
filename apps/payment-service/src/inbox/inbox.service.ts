import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InboxEventEntity } from './entities/inbox-event.entity';

@Injectable()
export class InboxService {
  constructor(
    @InjectRepository(InboxEventEntity)
    readonly events: Repository<InboxEventEntity>,
  ) {}
}
