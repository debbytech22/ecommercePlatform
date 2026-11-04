<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Protobuf contracts

The order and catalog service types are generated from the proto files in
`libs/contracts/src/proto`. After changing those schemas, regenerate the
TypeScript types with (requires `protoc` on `PATH`):

```bash
npm run generate:contracts
```

The generated types are exported by the contracts library and can be imported
using the `default/contracts` TypeScript alias. Nest continues to load the
`.proto` file at runtime for gRPC.

Order-service pricing requests use the catalog gRPC `GetPrices` RPC. Set
`CATALOG_GRPC_URL` in the order service to the catalog gRPC host and port
(default `127.0.0.1:50052`), and set `CATALOG_GRPC_BIND_URL` in the catalog
service if its bind address or port differs (default `0.0.0.0:50052`). Both
services must have the same `CATALOG_SERVICE_TOKEN`; order sends it as
`x-catalog-service-token` gRPC metadata. Keep this connection on a trusted
private network and configure transport security for deployments that cross
untrusted networks.

The catalog service owns a separate MySQL database. Configure
`CATALOG_DB_HOST`, `CATALOG_DB_PORT`, `CATALOG_DB_NAME`, `CATALOG_DB_USER`,
and `CATALOG_DB_PASSWORD`, plus `CATALOG_MYSQL_ROOT_PASSWORD` when using
Compose. For local development, start the databases with `docker compose up -d`,
then apply the catalog schema with `npm run migration:run:catalog`. Run
`npm run migration:run:orders` for the order database as well. The order
migrations enforce customer-scoped idempotency uniqueness, validate stored
request fingerprints and monetary/quantity invariants, and create the
transactional outbox schema.

The Inventory Service uses a separate MySQL database. Configure
`INVENTORY_DB_HOST`, `INVENTORY_DB_PORT`, `INVENTORY_DB_NAME`,
`INVENTORY_DB_USER`, and `INVENTORY_DB_PASSWORD`; when using Compose, also set
`INVENTORY_MYSQL_ROOT_PASSWORD`. Start the database with
`docker compose up -d inventory-mysql` and apply its schema with
`npm run migration:run:inventory`.
Inventory quantities are unsigned integers, and the database enforces that
reserved stock cannot exceed on-hand stock. Stock decreases use a conditional
atomic update requiring sufficient available stock (`on_hand - reserved`),
so competing decreases cannot oversell. The domain operations are exposed
through `InventoryService`; requested-quantity validation is advisory, while
the atomic stock decrease is the authoritative concurrency-safe adjustment.
The inventory inbox uses the OrderCreated event ID as its primary key. Inbox
insertion, consumer business work, and the processed status transition are
performed in one database transaction. A failure rolls back the inbox row and
business changes so RabbitMQ redelivery can retry; acknowledge the broker
delivery only after `OrderCreatedConsumer.consume` resolves. Duplicate
processed events are ignored, while a reused event ID with a different event
type is rejected.

The Inventory Service consumes `order.created.v1` from the durable
`inventory.order-created` queue on `ecommerce.events`. Configure
`INVENTORY_ORDER_CREATED_QUEUE`, `INVENTORY_RABBITMQ_PREFETCH`,
`INVENTORY_DEAD_LETTER_EXCHANGE`, and `INVENTORY_DEAD_LETTER_QUEUE` to
override the defaults. Malformed or unprocessable messages are rejected without
requeue and routed to the durable dead-letter queue for inspection/replay.
The inventory reservation and result outbox event are committed together with
the inbox record. Apply the inventory schema with
`npm run migration:run:inventory` before starting the consumer.
The Inventory Service publishes durable, persistent `inventory.reserved.v1`
and `inventory.reservation_failed.v1` envelopes through its transactional
outbox to `ecommerce.events`. Publisher confirms are required before
`published_at` is recorded. Delivery is at-least-once; consumers of these
result events must deduplicate by `eventId`.
Transient database failures, including deadlocks and lock timeouts, are retried
through a durable delay queue with exponential backoff. Configure
`INVENTORY_CONSUMER_MAX_RETRIES` (default `5`),
`INVENTORY_CONSUMER_RETRY_BASE_DELAY_MS` (default `1000`), and
`INVENTORY_CONSUMER_RETRY_MAX_DELAY_MS` (default `30000`). The original message
is acknowledged only after the retry copy is publisher-confirmed. Malformed or
unprocessable events and exhausted retries go to the durable dead-letter
queue; broker redelivery after a consumer crash is safe because the inbox
deduplicates processed event IDs.

Inventory logs are JSON structured and include event, correlation, and
causation IDs when available. The Inventory Service exposes one
Prometheus-compatible `GET /metrics` endpoint on port `9465` by default
(configure `INVENTORY_OUTBOX_METRICS_HOST` and
`INVENTORY_OUTBOX_METRICS_PORT`). It reports durable reservation success and
business-failure totals, outbox backlog/terminal failures and age, old active
reservations, RabbitMQ connection state/reconnect attempts, consumer outcomes,
and an `inventory_reservation_processing_seconds` latency histogram. Consumer
outcome counters are process-local and reset at restart; reservation and
outbox gauges/totals are read from MySQL.

Set `INVENTORY_STUCK_RESERVATION_AGE_SECONDS` (default `3600`) to define when
an active reservation is considered aged/stuck. Prometheus alert rules for
disconnected RabbitMQ, growing/failed outbox, aged reservations, DLQ traffic,
elevated consumer failures, and high reservation failure ratio are provided in
[`monitoring/prometheus/inventory-alerts.yml`](./monitoring/prometheus/inventory-alerts.yml).
Load that rule file into Prometheus and route firing alerts to your operational
notification system. Protect the metrics endpoint to trusted monitoring
networks.

The `ReservationsService.releaseReservation(reservationId)` domain operation
locks the reservation and its inventory rows in a transaction, releases stock
only for an active `RESERVED` reservation, and changes its status to
`RELEASED`. Repeated calls are idempotent and do not release stock again;
failed or missing reservations are not released. Apply the Inventory
migrations, including the released-status migration, before using this
operation.

The real Inventory integration suite requires a dedicated RabbitMQ broker and
an Inventory MySQL database whose name ends in `_test`. Set
`INVENTORY_INTEGRATION_TEST=true`, `INVENTORY_DB_HOST`,
`INVENTORY_DB_PORT`, `INVENTORY_DB_NAME`, `INVENTORY_DB_USER`,
`INVENTORY_DB_PASSWORD`, and `RABBITMQ_URL`, then run
`npm run test:inventory-integration`. The suite sends real RabbitMQ deliveries
and checks duplicate event handling, concurrent reservations against limited
stock, publisher-confirm and unroutable-message retry behavior, result event
routing, and idempotent cancellation. It cleans only rows created with its
unique integration-run IDs. Never point it at a production database or broker.

The Order Service publishes outbox events through RabbitMQ. Configure
`RABBITMQ_URL` (for example `amqp://user:password@localhost:5672`),
`RABBITMQ_ORDERS_EXCHANGE` (defaults to `ecommerce.events`),
`OUTBOX_POLL_INTERVAL_MS` (defaults to `1000`),
`OUTBOX_BATCH_SIZE` (defaults to `25`, maximum `100`),
and `RABBITMQ_CONFIRM_TIMEOUT_MS` (defaults to `10000`). Local Compose starts
RabbitMQ with a durable topic exchange created by the service; set `RABBITMQ_USER` and
`RABBITMQ_PASSWORD` in `.env`, then include `RABBITMQ_URL` in the Order
Service environment. Events use their outbox ID as the RabbitMQ message ID
and are marked published only after a publisher confirmation. Delivery is
at-least-once: if RabbitMQ confirms delivery but the service fails before it
records `published_at`, the same outbox event may be published again. Consumers
must deduplicate by `eventId` (also the AMQP `messageId`) and make processing
idempotent, ideally by recording the event ID in an inbox table with a unique
constraint in the same transaction as the consumer's business updates.

The routing key is the versioned event type, such as `order.created.v1`. Each
persistent message is a JSON envelope containing `eventId`, `eventType`,
`eventVersion`, `aggregateId`, `occurredAt`, `correlationId`, `causationId`,
and `payload`; the envelope currently uses event version `1`.

The Order Service also consumes the Saga result routing keys from the same
exchange using durable queue `order.saga-results` (override with
`ORDER_SAGA_RESULTS_QUEUE`). Malformed messages are dead-lettered to
`order.saga-results.dead-letter` through `order.saga.dead-letter`. Transient
processing failures are retried by confirmed persistent messages through
durable TTL queues with exponential delays; configure
`ORDER_SAGA_CONSUMER_MAX_RETRIES` (default `5`),
`ORDER_SAGA_CONSUMER_RETRY_BASE_DELAY_MS` (default `1000`),
`ORDER_SAGA_CONSUMER_RETRY_MAX_DELAY_MS` (default `30000`), and
`ORDER_SAGA_PREFETCH` (default `10`). Exhausted messages are dead-lettered for
inspection and replay. Payment and Inventory must consume the Saga command
events and publish the corresponding result events using the original
correlation ID.

For production, use a dedicated least-privilege RabbitMQ account and store
connection details in your deployment secret manager. Use an `amqps://` URL
for TLS; certificate verification is enabled. Set
`RABBITMQ_TLS_REQUIRED=true` to reject non-TLS URLs. Optionally configure
`RABBITMQ_TLS_CA` with the trusted CA PEM (newlines may be represented as
`\n`) and `RABBITMQ_TLS_SERVER_NAME` when the broker certificate requires a
specific server name. Local Compose is intended for development and does not
configure TLS.

Connection failures, including a missing `RABBITMQ_URL`, are retried with
exponential backoff and jitter. Configure
`RABBITMQ_RECONNECT_BASE_DELAY_MS` (defaults to `1000`) and
`RABBITMQ_RECONNECT_MAX_DELAY_MS` (defaults to `30000`). Restart the service
after correcting startup environment configuration. Outbox publish failures
also use exponential backoff with jitter, capped at five minutes. Configure
`OUTBOX_MAX_ATTEMPTS` (defaults to `10`) to set the maximum automatic
publication attempts. Once exhausted, the event is retained with `failed_at`
and `last_error` set; it is not deleted or automatically retried.

Expired publisher claims are recoverable: a claim's 60-second lease makes the
event eligible for another publisher when the lease expires. Use the
Prometheus-compatible `GET /metrics` endpoint on port `9464` (configurable via
`OUTBOX_METRICS_HOST` and `OUTBOX_METRICS_PORT`) to scrape pending event count,
terminal failure count, cumulative recorded publish failures, and oldest
pending event age. Restrict access to this endpoint to trusted monitoring
networks.

For manual recovery, first inspect the terminal event and capture its error:

```sql
SELECT `id`, `event_type`, `aggregate_id`, `attempts`, `last_error`, `failed_at`
FROM `outbox_events`
WHERE `failed_at` IS NOT NULL
ORDER BY `failed_at`, `id`;
```

After investigating and correcting the cause, an operator can explicitly
requeue one event by its reviewed ID. This preserves its attempt count and
error history; a failed manual retry will return it to the terminal state.

```sql
UPDATE `outbox_events`
SET `failed_at` = NULL,
    `next_attempt_at` = UTC_TIMESTAMP(6),
    `locked_by` = NULL,
    `locked_until` = NULL
WHERE `id` = '<reviewed-event-id>'
  AND `failed_at` IS NOT NULL
  AND `published_at` IS NULL;
```

Confirm exactly one row was affected, then monitor the event and metrics until
it is published or requires another intervention. Apply the Order Service
migrations before deploying this behavior:
`npm run migration:run:orders`.

The Order Service initializes one durable Saga and its steps in the same
transaction that creates the order and `order.created.v1` outbox event. A new
Saga starts in `INVENTORY_RESERVATION_PENDING`. Inventory results advance it
through payment authorization and confirmation, or mark it `FAILED` if
reservation fails. A confirmed payment creates an `order.confirmed.v1` outbox
event and marks the Saga `COMPLETED` and the order `CONFIRMED` in the same
transaction. The existing publisher subsequently delivers the durable outbox
event and retries until confirmed.

The shared Saga contracts use the common versioned envelope. Order commands
are `payment.authorize.v1`, `payment.void.v1`, `payment.refund.v1`,
`payment.reconcile.v1`, and `inventory.release.v1`; each carries a stable
`commandId` in its payload for idempotent command handling. Results consumed by Order are `inventory.reserved.v1`,
`inventory.reservation_failed.v1`, `payment.authorized.v1`,
`payment.authorization_failed.v1`, `payment.authorization_uncertain.v1`,
`payment.reconciled.v1`, `payment.voided.v1`, `payment.refunded.v1`, and
`inventory.released.v1`. Explicit void/release/refund failures are retried
within a bounded policy and escalate to `MANUAL_INTERVENTION_REQUIRED` when
exhausted. An authorized but uncaptured
payment is voided; a captured payment is refunded. Inconclusive payment
reconciliation is logged as a critical structured operational alert and
requires reconciliation. A late successful authorization received after
compensation starts is persisted and voided; stale compensation failures and
results from superseded retries are ignored only when their command ID is
verified against the persisted Outbox.

Persisted Saga state uses the workflow states `PENDING`,
`INVENTORY_RESERVATION_PENDING`, `INVENTORY_RESERVED`, `PAYMENT_PENDING`,
`PAYMENT_AUTHORIZED`, `CONFIRMATION_PENDING`, `COMPLETED`, `COMPENSATING`,
`COMPENSATION_PENDING`, the action-specific compensation pending states,
`COMPENSATION_PARTIALLY_COMPLETED`, `COMPENSATED`, `COMPENSATION_FAILED`,
`FAILED`, and `MANUAL_INTERVENTION_REQUIRED`. Saga rows persist the
compensation reason, status, timestamps, and failure detail alongside
payment/reservation IDs. Saga-step rows keep distinct compensation operations,
stable operation IDs, command IDs, attempt counts, retry times, and
start/completion times. Consumed event IDs are persisted in the unique Order
inbox table. Saga state transitions, inbox updates, order changes, and
follow-up commands use transactions; the existing Order outbox is reused
rather than creating a second outbox implementation.

Use `SagaOrchestratorService.startCompensation` with a
`CompensationReason` to initiate the policy-driven workflow. It voids an
authorization or refunds a captured payment before releasing inventory; a
definitive authorization failure only releases inventory. An uncertain payment
outcome is reconciled first, without releasing inventory. Commands are written
to the Outbox within the compensation transaction. Outbox publication retries
retain their command IDs; bounded compensation-operation retries preserve the
underlying operation ID, use capped exponential backoff with jitter, and create
a new command ID for each retry. Exhausted retries enter manual intervention.
Successful results from an older retry can still complete the current operation
when the stable operation ID and persisted command are verified; stale failure
results cannot schedule another retry.
`SagaRecoveryService.findStaleSagas`
provides a persisted view of workflows needing recovery or operator
reconciliation; it does not guess whether an external payment or inventory
operation succeeded. Apply the Order and Inventory migrations with
`npm run migration:run:orders` and `npm run migration:run:inventory`.

Saga steps persist deadlines. The Order Service recovery poller runs every
`SAGA_RECOVERY_POLL_INTERVAL_MS` (default `15000`); the persisted workflow step
timeout is 60 seconds. It republishes
inventory and compensation outbox messages with their original event/command
IDs, reconciles payment authorization timeouts rather than issuing another
authorization, and escalates exhausted or inconsistent workflows to
`MANUAL_INTERVENTION_REQUIRED`. Recovery metrics are exposed at
`http://127.0.0.1:9465/metrics` by default; configure `SAGA_METRICS_HOST` and
`SAGA_METRICS_PORT` to match deployment monitoring. Compensation metrics expose
initiations, pending steps, retry attempts, oldest active age, manual
interventions, and average duration by compensation step. The related
Prometheus alert rules are in
[`monitoring/prometheus/saga-compensation-alerts.yml`](./monitoring/prometheus/saga-compensation-alerts.yml);
load that rule file and route firing alerts to your operational notification
system.

Authenticated operations endpoints share the Saga metrics listener. Set
`SAGA_OPERATIONS_TOKEN` to enable them, then use
`GET /sagas/{orderId}` to inspect a workflow and
`POST /sagas/{orderId}/reconcile-payment` to enqueue a fresh payment status
reconciliation for a Saga requiring manual intervention. Requests require
`Authorization: Bearer <SAGA_OPERATIONS_TOKEN>`. Keep the listener on a trusted
network and protect the token as a secret.

The Payment Service exposes compensation operation state and duration metrics
at `http://127.0.0.1:${PAYMENT_SERVICE_PORT:-3000}/metrics`. These include
durable void/refund operation counts by status and unresolved provider outcomes.
Prometheus alert rules are in
[`monitoring/prometheus/payment-compensation-alerts.yml`](./monitoring/prometheus/payment-compensation-alerts.yml);
scrape the Payment Service endpoint and load the Saga and Payment alert files
to notify operators about overdue compensation or unresolved provider work.

For a compensation alert, inspect `GET /sagas/{orderId}` and record the Saga,
step, command, and operation IDs plus `lastError` and `nextRetryAt`. Verify
inventory state in `inventory_reservations` and payment provider state in
`payment_operations` before taking action. Do not edit Saga, reservation, or
payment rows to force completion, and do not replay a new command with a new
operation ID. Use the existing payment reconciliation endpoint for uncertain
provider outcomes; for other exhausted compensation steps, resolve the
underlying issue and follow the deployment's audited manual-recovery process
before resuming the workflow.

## Customer Order Reads

The API Gateway exposes these authenticated read-only endpoints:

- `GET /orders?page=1&limit=20&status=CONFIRMED` — paginated customer history.
- `GET /orders/{orderId}` — order details and persisted line items.
- `GET /orders/{orderId}/status` — the current persisted Order Service status.
- `GET /orders/{orderId}/timeline` — persisted customer-visible state changes.

The Gateway accepts HS256 bearer tokens only. Configure
`CUSTOMER_JWT_SECRET` (at least 32 UTF-8 bytes),
`CUSTOMER_JWT_ISSUER`, and `CUSTOMER_JWT_AUDIENCE`. Tokens must include matching
`iss` and `aud`, a non-expired `exp`, and the customer identifier in `sub`.
The Gateway verifies the signature and claims before forwarding the `sub` as
trusted gRPC metadata; it never accepts a customer ID from a URL or query
parameter. Keep the shared signing secret restricted to the identity issuer
and Gateway. Set `ORDER_GRPC_URL` to the Order Service address (defaults to
`127.0.0.1:50051`).

Order Service remains the source of truth for status; only its canonical
persisted statuses are returned. The Gateway uses 3-second gRPC deadlines and
retries a read once only for `UNAVAILABLE`. Order database reads have a
3-second query limit. Responses are not cached: MySQL remains authoritative,
and no Redis authorization or status cache is introduced. The Gateway applies
a per-process limit of 60 order reads per customer per minute; deployments
with multiple replicas should also apply a shared rate limit at the ingress.
Keep Gateway gRPC traffic on a trusted service network.

Order status transitions and `order_status_history` rows are committed in the
same MySQL transaction. Apply the new Order Service migration through the
normal deployment workflow with `npm run migration:run:orders`; do not enable
TypeORM schema synchronization. The migration deliberately does not fabricate
history for existing orders. Their timeline begins only when a new persisted
transition is recorded; any historical backfill must use a separately reviewed
trusted source with real transition timestamps.

Prometheus query metrics are exposed at the Gateway's `/metrics` endpoint and
alongside the Order Saga metrics. They include request/error counts by query
type, query duration histograms, inaccessible/not-found totals, and gRPC
failures. Metrics contain no customer IDs or payment details. Restrict
`/metrics` to trusted monitoring networks. Use the MySQL exporter for database
and connection-pool utilization rather than inferring pool usage from private
TypeORM/mysql2 internals.

The Inventory Service outbox uses `INVENTORY_OUTBOX_POLL_INTERVAL_MS`
(default `1000`), `INVENTORY_OUTBOX_BATCH_SIZE` (default `25`, maximum `100`),
and `INVENTORY_OUTBOX_MAX_ATTEMPTS` (default `10`). Retry delay is exponential
and capped at five minutes. Events that exhaust their attempts remain in the
database with `failed_at` and `last_error` populated; they are not discarded.
Stale publisher claims expire after one minute and become eligible for another
publisher. Scrape the Prometheus-compatible `/metrics` endpoint on port `9465`
(configurable with `INVENTORY_OUTBOX_METRICS_HOST` and
`INVENTORY_OUTBOX_METRICS_PORT`) for pending events, terminal failures,
recorded publish failures, oldest pending event age, reservation outcome
totals, active reservation age, RabbitMQ connection state, consumer outcomes,
and processing latency. Restrict access to trusted monitoring networks.

The Inventory Prometheus alert rules are in
[`monitoring/prometheus/inventory-alerts.yml`](./monitoring/prometheus/inventory-alerts.yml).
They flag disconnected RabbitMQ connections, growing or terminal outbox
failures, aged active reservations, dead-lettered messages, elevated consumer
failures, and a high reservation failure ratio. Configure Prometheus to load
this rule file and route alerts to your notification system.

For manual inventory outbox recovery, inspect failed events and their error
before deciding whether to requeue:

```sql
SELECT `id`, `event_type`, `aggregate_id`, `attempts`, `last_error`, `failed_at`
FROM `outbox_events`
WHERE `failed_at` IS NOT NULL
ORDER BY `failed_at`, `id`;
```

After correcting the cause and reviewing the event, requeue only the selected
ID:

```sql
UPDATE `outbox_events`
SET `failed_at` = NULL,
    `next_attempt_at` = UTC_TIMESTAMP(6),
    `locked_by` = NULL,
    `locked_until` = NULL
WHERE `id` = '<reviewed-event-id>'
  AND `failed_at` IS NOT NULL
  AND `published_at` IS NULL;
```

Verify one row was affected, then monitor that event until it is published or
again requires intervention.

The order-creation integration suite requires two dedicated MySQL databases
whose names end in `_test`. Set `ORDER_TEST_DB_NAME` and
`CATALOG_TEST_DB_NAME` to those database names, and configure the normal
`ORDER_DB_HOST`, `ORDER_DB_PORT`, `ORDER_DB_USER`, `ORDER_DB_PASSWORD`,
`CATALOG_DB_HOST`, `CATALOG_DB_PORT`, `CATALOG_DB_USER`, and
`CATALOG_DB_PASSWORD` values with credentials permitted to create and drop
tables/triggers in those test databases. Set `RABBITMQ_TEST_URL` to a
dedicated test vhost on RabbitMQ as well. Run it with
`npm run test:order-integration`. The suite runs exactly two end-to-end tests
against the real Catalog gRPC server, MySQL migrations, and RabbitMQ publisher;
it clears only the current process's integration-customer orders and prefixed
products from the explicitly named `*_test` databases.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

This project is already instrumented. To connect it, run this and approve the code it prints at [observe.nestjs.com/link](https://observe.nestjs.com/link) - signing up for free if you have no account:

```bash
$ npx @nestjs/observe link
```

It writes the app key and secret into `.env` and makes every `nest start` script (`start`, `start:dev`, `start:debug`) load it. In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment instead.

Or do it by hand: create an application and an API key at [observe.nestjs.com](https://observe.nestjs.com), and set the pair as `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment the app runs in.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
