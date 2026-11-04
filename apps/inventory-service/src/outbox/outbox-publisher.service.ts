import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { InventoryEventPublisher } from '../messaging/publishers/inventory-event.publisher';
import { InventoryMetricsService } from '../observability/inventory-metrics.service';
import { OutboxRepository } from './outbox.repository';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const CLAIM_LEASE_MS = 60_000;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 10;

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly metricsHost: string;
  private readonly metricsPort: number;
  private readonly stuckReservationAgeSeconds: number;
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;
  private metricsServer: Server | undefined;
  private stopping = false;

  constructor(
    private readonly repository: OutboxRepository,
    @Inject(InventoryEventPublisher)
    private readonly publisher: InventoryEventPublisher,
    private readonly config: ConfigService,
    private readonly inventoryMetrics: InventoryMetricsService,
  ) {
    this.pollIntervalMs = this.readPositiveInteger(
      'INVENTORY_OUTBOX_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.batchSize = this.readPositiveInteger(
      'INVENTORY_OUTBOX_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
    );
    if (this.batchSize > MAX_BATCH_SIZE) {
      throw new Error(
        `INVENTORY_OUTBOX_BATCH_SIZE must not exceed ${MAX_BATCH_SIZE}`,
      );
    }
    this.maxAttempts = this.readPositiveInteger(
      'INVENTORY_OUTBOX_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
    );
    this.metricsHost = config.get<string>(
      'INVENTORY_OUTBOX_METRICS_HOST',
      '0.0.0.0',
    );
    this.metricsPort = this.readPositiveInteger(
      'INVENTORY_OUTBOX_METRICS_PORT',
      9465,
    );
    this.stuckReservationAgeSeconds = this.readPositiveInteger(
      'INVENTORY_STUCK_RESERVATION_AGE_SECONDS',
      3600,
    );
  }

  onModuleInit(): void {
    this.startMetricsServer();
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.activePoll;
    await this.stopMetricsServer();
  }

  async poll(): Promise<void> {
    if (this.stopping || this.activePoll) {
      return this.activePoll;
    }
    this.activePoll = this.publishAvailable().finally(() => {
      this.activePoll = undefined;
    });
    return this.activePoll;
  }

  private async publishAvailable(): Promise<void> {
    let claimed: Awaited<ReturnType<OutboxRepository['claimBatch']>>;
    try {
      claimed = await this.repository.claimBatch(
        this.batchSize,
        CLAIM_LEASE_MS,
      );
    } catch (error) {
      this.log('error', 'inventory.outbox.claim.failed', {
        error: this.errorMessage(error),
        stack: this.errorStack(error),
      });
      return;
    }
    await Promise.all(
      claimed.events.map((event) =>
        this.publishClaimedEvent(
          event.id,
          event.eventType,
          event.payload,
          event.attempts,
          claimed.claimToken,
        ),
      ),
    );
  }

  private async publishClaimedEvent(
    id: string,
    eventType: string,
    payload: Parameters<InventoryEventPublisher['publish']>[0],
    attempts: number,
    claimToken: string,
  ): Promise<void> {
    if (this.stopping) {
      return;
    }

    try {
      await this.publisher.publish(payload);
      const marked = await this.repository.markPublished(id, claimToken);
      if (!marked) {
        this.log('error', 'inventory.outbox.mark_published.lost_claim', {
          eventId: id,
          eventType,
          ...this.eventMetadata(payload),
        });
        return;
      }
      this.log('log', 'inventory.outbox.event.published', {
        eventId: id,
        eventType,
        attempts,
        ...this.eventMetadata(payload),
      });
    } catch (error) {
      const message = this.errorMessage(error);
      try {
        const retryDelayMs = this.retryDelay(attempts);
        const result = await this.repository.scheduleRetry(
          id,
          claimToken,
          retryDelayMs,
          message,
          attempts,
          this.maxAttempts,
        );
        if (result === 'not-owned') {
          this.log('warn', 'inventory.outbox.retry.lost_claim', {
            eventId: id,
            eventType,
          });
        } else if (result === 'exhausted') {
          this.log('error', 'inventory.outbox.manual_intervention_required', {
            eventId: id,
            eventType,
            attempts: attempts + 1,
            ...this.eventMetadata(payload),
            error: message,
          });
        } else {
          this.log('warn', 'inventory.outbox.retry.scheduled', {
            eventId: id,
            eventType,
            attempts: attempts + 1,
            retryDelayMs,
            ...this.eventMetadata(payload),
            error: message,
          });
        }
      } catch (retryError) {
        this.log('error', 'inventory.outbox.retry.schedule_failed', {
          eventId: id,
          error: this.errorMessage(retryError),
          stack: this.errorStack(retryError),
        });
      }
      this.log('error', 'inventory.outbox.publish.failed', {
        eventId: id,
        eventType,
        attempt: attempts + 1,
        maxAttempts: this.maxAttempts,
        ...this.eventMetadata(payload),
        error: message,
        stack: this.errorStack(error),
      });
    }
  }

  private retryDelay(attempts: number): number {
    const exponentialDelay = Math.min(
      INITIAL_RETRY_MS * 2 ** Math.min(Math.max(attempts, 0), 20),
      MAX_RETRY_MS,
    );
    return Math.min(
      MAX_RETRY_MS,
      Math.floor(exponentialDelay * (0.5 + Math.random())),
    );
  }

  private startMetricsServer(): void {
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404);
        response.end('Not Found');
        return;
      }
      void this.repository
        .getMetrics(this.stuckReservationAgeSeconds)
        .then((metrics) => {
          response.writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          });
          response.end(
            [
              '# HELP inventory_outbox_pending_events Number of pending inventory outbox events.',
              '# TYPE inventory_outbox_pending_events gauge',
              `inventory_outbox_pending_events ${metrics.pendingEvents}`,
              '# HELP inventory_outbox_failed_events Events requiring manual intervention.',
              '# TYPE inventory_outbox_failed_events gauge',
              `inventory_outbox_failed_events ${metrics.failedEvents}`,
              '# HELP inventory_outbox_publish_failures_total Recorded publish failures.',
              '# TYPE inventory_outbox_publish_failures_total counter',
              `inventory_outbox_publish_failures_total ${metrics.publishFailuresTotal}`,
              '# HELP inventory_outbox_oldest_pending_event_age_seconds Age of the oldest pending event.',
              '# TYPE inventory_outbox_oldest_pending_event_age_seconds gauge',
              `inventory_outbox_oldest_pending_event_age_seconds ${metrics.oldestPendingAgeSeconds}`,
              '# HELP inventory_reservations_succeeded_total Persisted successful inventory reservations.',
              '# TYPE inventory_reservations_succeeded_total counter',
              `inventory_reservations_succeeded_total ${metrics.reservationsSucceededTotal}`,
              '# HELP inventory_reservations_failed_total Persisted business reservation failures.',
              '# TYPE inventory_reservations_failed_total counter',
              `inventory_reservations_failed_total ${metrics.reservationsFailedTotal}`,
              '# HELP inventory_stuck_reservations Reservations still reserved beyond the configured age threshold.',
              '# TYPE inventory_stuck_reservations gauge',
              `inventory_stuck_reservations ${metrics.stuckReservations}`,
              '# HELP inventory_oldest_reserved_age_seconds Age of the oldest reservation still holding stock.',
              '# TYPE inventory_oldest_reserved_age_seconds gauge',
              `inventory_oldest_reserved_age_seconds ${metrics.oldestReservedAgeSeconds}`,
              '# HELP inventory_stuck_reservation_age_threshold_seconds Threshold used to count stuck reservations.',
              '# TYPE inventory_stuck_reservation_age_threshold_seconds gauge',
              `inventory_stuck_reservation_age_threshold_seconds ${this.stuckReservationAgeSeconds}`,
              this.inventoryMetrics.renderPrometheus(),
              '',
            ].join('\n'),
          );
        })
        .catch((error: unknown) => {
          this.log('error', 'inventory.outbox.metrics.query_failed', {
            error: this.errorMessage(error),
            stack: this.errorStack(error),
          });
          if (!response.headersSent) {
            response.writeHead(503);
          }
          response.end('Metrics temporarily unavailable');
        });
    });
    server.on('error', (error) => {
      this.log('error', 'inventory.outbox.metrics.server_failed', {
        host: this.metricsHost,
        port: this.metricsPort,
        error: this.errorMessage(error),
      });
    });
    server.listen(this.metricsPort, this.metricsHost, () => {
      this.metricsServer = server;
      this.log('log', 'inventory.outbox.metrics.server_started', {
        host: this.metricsHost,
        port: this.metricsPort,
      });
    });
  }

  private async stopMetricsServer(): Promise<void> {
    const server = this.metricsServer;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.metricsServer = undefined;
  }

  private readPositiveInteger(name: string, defaultValue: number): number {
    const configured = this.config.get<string>(name);
    if (configured === undefined) {
      return defaultValue;
    }
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/amqps?:\/\/[^@\s]+@/gi, (url) => {
      const protocol = url.startsWith('amqps:') ? 'amqps' : 'amqp';
      return `${protocol}://[redacted]@`;
    });
  }

  private errorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }

  private eventMetadata(event: {
    correlationId: string;
    causationId: string | null;
  }): { correlationId: string; causationId: string | null } {
    return {
      correlationId: event.correlationId,
      causationId: event.causationId,
    };
  }

  private log(
    level: 'log' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void {
    const output = JSON.stringify({ event, ...fields });
    if (level === 'error') {
      this.logger.error(output);
    } else if (level === 'warn') {
      this.logger.warn(output);
    } else {
      this.logger.log(output);
    }
  }
}
