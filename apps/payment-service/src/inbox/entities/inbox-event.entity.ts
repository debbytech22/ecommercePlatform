import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export enum InboxEventStatus {
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

@Entity({ name: 'payment_inbox_events' })
@Index('uq_payment_inbox_event_id', ['eventId'], { unique: true })
@Index('idx_payment_inbox_status_received', ['status', 'receivedAt'])
export class InboxEventEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'event_id', type: 'char', length: 36 })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 120 })
  eventType!: string;

  @Column({ name: 'aggregate_id', type: 'char', length: 36 })
  aggregateId!: string;

  @Column({ name: 'correlation_id', type: 'char', length: 36 })
  correlationId!: string;

  @Column({ name: 'processing_status', type: 'varchar', length: 20 })
  status!: InboxEventStatus;

  @CreateDateColumn({ name: 'received_at', type: 'datetime', precision: 6 })
  receivedAt!: Date;

  @Column({
    name: 'processed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  processedAt!: Date | null;
}
