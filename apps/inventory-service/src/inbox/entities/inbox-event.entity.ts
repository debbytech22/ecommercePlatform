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
}

@Entity({ name: 'inbox_events' })
@Index('idx_inbox_event_status_received', ['status', 'receivedAt'])
export class InboxEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'char', length: 36 })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 120 })
  eventType!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: InboxEventStatus.PROCESSING,
  })
  status!: InboxEventStatus;

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
