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
  @PrimaryColumn({ type: 'char', length: 36 })
  eventId!: string;

  @Column({  type: 'varchar', length: 120 })
  eventType!: string;

  @Column({  type: 'char', length: 36 })
  aggregateId!: string;

  @Column({  type: 'char', length: 36 })
  correlationId!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'RECEIVED',
  })
  processingStatus!: 'RECEIVED' | 'PROCESSED';

  @CreateDateColumn({
    type: 'datetime',
    precision: 6,
  })
  receivedAt!: Date;

  @Column({
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  processedAt!: Date | null;
}
