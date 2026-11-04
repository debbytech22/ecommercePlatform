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

import { OutboxRepository } from './outbox.repository';
import type { OutboxEvent, OutboxPublisher } from './outbox-event.types';
import { RabbitMqPublisher } from './rabbitmq/rabbitmq.publisher';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const CLAIM_LEASE_MS = 60_000;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_METRICS_PORT = 9464;

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly metricsHost: string;
  private readonly metricsPort: number;
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;
  private metricsServer: Server | undefined;
  private stopping = false;

  constructor(
    private readonly repository: OutboxRepository,
    @Inject(RabbitMqPublisher)
    private readonly publisher: OutboxPublisher,
    private readonly config: ConfigService,
  ) {
    this.pollIntervalMs = this.readPositiveInteger(
      'OUTBOX_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.batchSize = this.readPositiveInteger(
      'OUTBOX_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
    );
    if (this.batchSize > MAX_BATCH_SIZE) {
      throw new Error(`OUTBOX_BATCH_SIZE must not exceed ${MAX_BATCH_SIZE}`);
    }
    this.maxAttempts = this.readPositiveInteger(
      'OUTBOX_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
    );
    this.metricsHost = this.config.get<string>(
      'OUTBOX_METRICS_HOST',
      '0.0.0.0',
    );
    this.metricsPort = this.readPositiveInteger(
      'OUTBOX_METRICS_PORT',
      DEFAULT_METRICS_PORT,
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
      this.logger.error(
        this.structuredLog('outbox.claim.failed', {
          error: this.errorMessage(error),
          stack: this.errorStack(error),
        }),
      );
      return;
    }

    await Promise.all(
      claimed.events.map((event) =>
        this.publishClaimedEvent(event, claimed.claimToken),
      ),
    );
  }

  private async publishClaimedEvent(
    event: OutboxEvent,
    claimToken: string,
  ): Promise<void> {
    if (this.stopping) {
      return;
    }

    try {
      await this.publisher.publish(event);
      const marked = await this.repository.markPublished(event.id, claimToken);
      if (!marked) {
        this.logError('outbox.mark_published.lost_claim', {
          eventId: event.id,
          eventType: event.eventType,
        });
      } else {
        this.logInfo('outbox.event.published', {
          eventId: event.id,
          eventType: event.eventType,
          attempts: event.attempts,
        });
      }
    } catch (error) {
      try {
        const scheduled = await this.repository.scheduleRetry(
          event.id,
          claimToken,
          this.retryDelay(event.attempts),
          this.errorMessage(error),
          event.attempts,
          this.maxAttempts,
        );
        if (scheduled === 'not-owned') {
          this.logWarn('outbox.retry.lost_claim', {
            eventId: event.id,
            eventType: event.eventType,
          });
        } else if (scheduled === 'exhausted') {
          this.logError('outbox.event.manual_intervention_required', {
            eventId: event.id,
            eventType: event.eventType,
            attempts: event.attempts + 1,
            error: this.errorMessage(error),
          });
        } else {
          this.logWarn('outbox.retry.scheduled', {
            eventId: event.id,
            eventType: event.eventType,
            attempts: event.attempts + 1,
            retryDelayMs: this.retryDelay(event.attempts),
            error: this.errorMessage(error),
          });
        }
      } catch (retryError) {
        this.logError('outbox.retry.schedule_failed', {
          eventId: event.id,
          error: this.errorMessage(retryError),
          stack: this.errorStack(retryError),
        });
      }

      this.logError('outbox.publish.failed', {
        eventId: event.id,
        eventType: event.eventType,
        attempt: event.attempts + 1,
        maxAttempts: this.maxAttempts,
        error: this.errorMessage(error),
        stack: this.errorStack(error),
      });
    }
  }

  private retryDelay(attempts: number): number {
    const exponent = Math.min(Math.max(attempts, 0), 20);
    const backoffDelay = Math.min(
      INITIAL_RETRY_MS * 2 ** exponent,
      MAX_RETRY_MS,
    );
    return Math.min(
      MAX_RETRY_MS,
      Math.floor(backoffDelay * (0.5 + Math.random())),
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
        .getMetrics()
        .then((metrics) => {
          response.writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          });
          response.end(
            [
              '# HELP outbox_pending_events Number of unpublished, non-terminal outbox events.',
              '# TYPE outbox_pending_events gauge',
              `outbox_pending_events ${metrics.pendingEvents}`,
              '# HELP outbox_failed_events Number of events requiring manual intervention.',
              '# TYPE outbox_failed_events gauge',
              `outbox_failed_events ${metrics.failedEvents}`,
              '# HELP outbox_publish_failures_total Total publish failures recorded in the outbox.',
              '# TYPE outbox_publish_failures_total counter',
              `outbox_publish_failures_total ${metrics.publishFailuresTotal}`,
              '# HELP outbox_oldest_pending_event_age_seconds Age of the oldest pending outbox event.',
              '# TYPE outbox_oldest_pending_event_age_seconds gauge',
              `outbox_oldest_pending_event_age_seconds ${metrics.oldestPendingAgeSeconds}`,
              '',
            ].join('\n'),
          );
        })
        .catch((error: unknown) => {
          this.logError('outbox.metrics.query_failed', {
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
      this.logError('outbox.metrics.server_failed', {
        host: this.metricsHost,
        port: this.metricsPort,
        error: this.errorMessage(error),
      });
    });
    server.listen(this.metricsPort, this.metricsHost, () => {
      this.metricsServer = server;
      this.logInfo('outbox.metrics.server_started', {
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
    this.metricsServer = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }).catch((error: unknown) => {
      this.logError('outbox.metrics.server_close_failed', {
        error: this.errorMessage(error),
      });
    });
  }

  private structuredLog(
    event: string,
    fields: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      component: 'order-outbox',
      event,
      ...fields,
    });
  }

  private logInfo(event: string, fields: Record<string, unknown>): void {
    this.logger.log(this.structuredLog(event, fields));
  }

  private logWarn(event: string, fields: Record<string, unknown>): void {
    this.logger.warn(this.structuredLog(event, fields));
  }

  private logError(event: string, fields: Record<string, unknown>): void {
    this.logger.error(this.structuredLog(event, fields));
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
    return error instanceof Error ? error.message : String(error);
  }

  private errorStack(error: unknown): string {
    return error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
  }
}
