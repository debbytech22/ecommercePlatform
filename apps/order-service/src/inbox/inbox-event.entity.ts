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
  @PrimaryColumn({ name: 'event_id', type: 'char', length: 36 })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 120 })
  eventType!: string;

  @Column({ name: 'aggregate_id', type: 'char', length: 36 })
  aggregateId!: string;

  @Column({ name: 'correlation_id', type: 'char', length: 36 })
  correlationId!: string;

  @Column({
    name: 'processing_status',
    type: 'varchar',
    length: 20,
    default: 'RECEIVED',
  })
  processingStatus!: 'RECEIVED' | 'PROCESSED';

  @CreateDateColumn({
    name: 'received_at',
    type: 'datetime',
    precision: 6,
  })
  receivedAt!: Date;

  @Column({
    name: 'processed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  processedAt!: Date | null;
}
