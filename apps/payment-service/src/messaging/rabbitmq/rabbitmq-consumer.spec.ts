import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { Channel, ConsumeMessage } from 'amqplib';
import { PAYMENT_AUTHORIZE_COMMAND_TYPE } from 'default/contracts';
import { PaymentAuthorizeConsumer } from '../consumers/payment-authorize.consumer';
import { PaymentCaptureConsumer } from '../consumers/payment-capture.consumer';
import { PaymentRefundConsumer } from '../consumers/payment-refund.consumer';
import { PaymentVoidConsumer } from '../consumers/payment-void.consumer';
import { RabbitMqPublisherChannel } from './rabbitmq-publisher-channel';
import { RabbitMqConsumer } from './rabbitmq-consumer';

describe('Payment RabbitMQ command acknowledgements', () => {
  it('acknowledges authorization only after durable command processing resolves', async () => {
    let finishProcessing: (() => void) | undefined;
    const authorize = {
      consume: jest.fn(
        () =>
          new Promise<'processed'>((resolve) => {
            finishProcessing = () => resolve('processed');
          }),
      ),
    } as unknown as PaymentAuthorizeConsumer;
    const consumer = new RabbitMqConsumer(
      new ConfigService(),
      authorize,
      { consume: jest.fn() } as unknown as PaymentCaptureConsumer,
      { consume: jest.fn() } as unknown as PaymentVoidConsumer,
      { consume: jest.fn() } as unknown as PaymentRefundConsumer,
      { getConfirmChannel: jest.fn() } as unknown as RabbitMqPublisherChannel,
    );
    const ack = jest.fn();
    const nack = jest.fn();
    const channel = { ack, nack } as unknown as Channel;
    const command = {
      commandId: 'command-1',
      commandType: PAYMENT_AUTHORIZE_COMMAND_TYPE,
      eventVersion: 1,
      aggregateId: 'order-1',
      occurredAt: '2026-11-02T10:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: null,
      payload: { orderId: 'order-1' },
    };
    const message = {
      content: Buffer.from(JSON.stringify(command)),
      fields: { routingKey: PAYMENT_AUTHORIZE_COMMAND_TYPE },
      properties: { messageId: 'command-1', headers: {} },
    } as unknown as ConsumeMessage;

    const delivery = consumer['handleDelivery'](channel, message);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    expect(authorize.consume).toHaveBeenCalledWith(command);
    finishProcessing?.();
    await delivery;

    expect(ack).toHaveBeenCalledWith(message);
    expect(nack).not.toHaveBeenCalled();
  });
});
