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

@Entity()
@Index('idx_inbox_event_status_received', ['status', 'receivedAt'])
export class InboxEventEntity {
  @PrimaryColumn()
  eventId!: string;

  @Column()
  eventType!: string;

  @Column({
    default: InboxEventStatus.PROCESSING,
  })
  status!: InboxEventStatus;

  @CreateDateColumn()
  receivedAt!: Date;

  @Column({
    nullable: true,
  })
  processedAt!: Date | null;
}
