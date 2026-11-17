import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({ name: 'order_inbox_events' })
@Index('idx_order_inbox_processed_at', ['processedAt'])
export class InboxEventEntity {
  @PrimaryColumn()
  eventId!: string;

  @Column()
  eventType!: string;

  @Column()
  aggregateId!: string;

  @Column()
  correlationId!: string;

  @Column({
    default: 'RECEIVED',
  })
  processingStatus!: 'RECEIVED' | 'PROCESSED';

  @CreateDateColumn()
  receivedAt!: Date;

  @Column({
    type: 'datetime',
    nullable: true,
  })
  processedAt!: Date | null;
}
