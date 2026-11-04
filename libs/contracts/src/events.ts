export const ORDER_CREATED_EVENT_TYPE = 'order.created.v1' as const;
export const ORDER_CONFIRMED_EVENT_TYPE = 'order.confirmed.v1' as const;
export const ORDER_CANCELLED_EVENT_TYPE = 'order.cancelled.v1' as const;
export const INVENTORY_RESERVED_EVENT_TYPE = 'inventory.reserved.v1' as const;
export const INVENTORY_RESERVATION_FAILED_EVENT_TYPE =
  'inventory.reservation_failed.v1' as const;
export const INVENTORY_RELEASED_EVENT_TYPE = 'inventory.released.v1' as const;
export const INVENTORY_RELEASE_FAILED_EVENT_TYPE =
  'inventory.release_failed.v1' as const;
export const PAYMENT_AUTHORIZED_EVENT_TYPE = 'payment.authorized.v1' as const;
export const PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE =
  'payment.authorization_failed.v1' as const;
export const PAYMENT_CAPTURED_EVENT_TYPE = 'payment.captured.v1' as const;
export const PAYMENT_CAPTURE_FAILED_EVENT_TYPE =
  'payment.capture_failed.v1' as const;
export const PAYMENT_REFUNDED_EVENT_TYPE = 'payment.refunded.v1' as const;
export const PAYMENT_REFUND_FAILED_EVENT_TYPE =
  'payment.refund_failed.v1' as const;
export const PAYMENT_VOIDED_EVENT_TYPE = 'payment.voided.v1' as const;
export const PAYMENT_VOID_FAILED_EVENT_TYPE = 'payment.void_failed.v1' as const;
export const PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE =
  'payment.authorization_uncertain.v1' as const;
export const PAYMENT_RECONCILED_EVENT_TYPE = 'payment.reconciled.v1' as const;
export const PAYMENT_AUTHORIZE_COMMAND_TYPE = 'payment.authorize.v1' as const;
export const PAYMENT_CAPTURE_COMMAND_TYPE = 'payment.capture.v1' as const;
export const PAYMENT_REFUND_COMMAND_TYPE = 'payment.refund.v1' as const;
export const PAYMENT_VOID_COMMAND_TYPE = 'payment.void.v1' as const;
export const PAYMENT_RECONCILE_COMMAND_TYPE = 'payment.reconcile.v1' as const;
export const INVENTORY_RELEASE_COMMAND_TYPE = 'inventory.release.v1' as const;

export interface EventEnvelope<
  EventType extends string,
  Payload,
  EventVersion extends number = 1,
> {
  eventId: string;
  eventType: EventType;
  eventVersion: EventVersion;
  aggregateId: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  payload: Payload;
}

export interface CommandEnvelope<
  CommandType extends string,
  Payload,
  CommandVersion extends number = 1,
> {
  commandId: string;
  commandType: CommandType;
  eventVersion: CommandVersion;
  aggregateId: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  payload: Payload;
}

export interface OrderCreatedItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
  currency: string;
  subtotalAmount: string;
  totalAmount: string;
  items: OrderCreatedItem[];
}

export type OrderCreatedEvent = EventEnvelope<
  typeof ORDER_CREATED_EVENT_TYPE,
  OrderCreatedPayload
>;

export interface OrderConfirmedPayload {
  orderId: string;
  customerId: string;
  inventoryReservationId: string;
  paymentId: string;
  paymentOperationId: string;
  paymentStatus: 'AUTHORIZED';
  amount: string;
  currency: string;
  confirmedAt: string;
}

export type OrderConfirmedEvent = EventEnvelope<
  typeof ORDER_CONFIRMED_EVENT_TYPE,
  OrderConfirmedPayload
>;

export interface OrderCancelledPayload {
  orderId: string;
  customerId: string;
  reasonCode: string;
  reason: string;
  cancelledAt: string;
}

export type OrderCancelledEvent = EventEnvelope<
  typeof ORDER_CANCELLED_EVENT_TYPE,
  OrderCancelledPayload
>;

export interface InventoryReservedItem {
  productId: string;
  quantity: number;
}

export interface InventoryReservedPayload {
  orderId: string;
  reservationId: string;
  items: InventoryReservedItem[];
}

export type InventoryReservedEvent = EventEnvelope<
  typeof INVENTORY_RESERVED_EVENT_TYPE,
  InventoryReservedPayload
>;

export const INVENTORY_RESERVATION_FAILURE_CODES = [
  'INSUFFICIENT_STOCK',
  'PRODUCT_NOT_FOUND',
  'INVALID_ORDER',
] as const;

export type InventoryReservationFailureCode =
  (typeof INVENTORY_RESERVATION_FAILURE_CODES)[number];

export interface InventoryReservationFailedItem {
  productId: string;
  requestedQuantity: number;
  availableQuantity: number | null;
}

export interface InventoryReservationFailedPayload {
  orderId: string;
  reasonCode: InventoryReservationFailureCode;
  reason: string;
  items: InventoryReservationFailedItem[];
}

export type InventoryReservationFailedEvent = EventEnvelope<
  typeof INVENTORY_RESERVATION_FAILED_EVENT_TYPE,
  InventoryReservationFailedPayload
>;

export interface InventoryReleaseCommandPayload {
  orderId: string;
  sagaId: string;
  reservationId: string;
  releaseOperationId: string;
  reasonCode: string;
}

export type InventoryReleaseCommand = CommandEnvelope<
  typeof INVENTORY_RELEASE_COMMAND_TYPE,
  InventoryReleaseCommandPayload
>;

export interface InventoryReleasedPayload {
  orderId: string;
  sagaId: string;
  reservationId: string;
  releaseOperationId: string;
  releasedItems: InventoryReservedItem[];
}

export type InventoryReleasedEvent = EventEnvelope<
  typeof INVENTORY_RELEASED_EVENT_TYPE,
  InventoryReleasedPayload
>;

export interface InventoryReleaseFailedPayload {
  orderId: string;
  sagaId: string;
  reservationId: string;
  releaseOperationId: string;
  reasonCode: string;
  reason: string;
}

export type InventoryReleaseFailedEvent = EventEnvelope<
  typeof INVENTORY_RELEASE_FAILED_EVENT_TYPE,
  InventoryReleaseFailedPayload
>;

export interface PaymentAuthorizeCommandPayload {
  orderId: string;
  customerId: string;
  amount: string;
  currency: string;
  paymentOperationId: string;
  paymentMethodReference?: string;
}

export type PaymentAuthorizeCommand = CommandEnvelope<
  typeof PAYMENT_AUTHORIZE_COMMAND_TYPE,
  PaymentAuthorizeCommandPayload
>;

export interface PaymentRefundCommandPayload {
  orderId: string;
  sagaId: string;
  refundOperationId: string;
  paymentOperationId: string;
  amount: string;
  currency: string;
  reasonCode: string;
}

export type PaymentRefundCommand = CommandEnvelope<
  typeof PAYMENT_REFUND_COMMAND_TYPE,
  PaymentRefundCommandPayload
>;

export interface PaymentVoidCommandPayload {
  orderId: string;
  sagaId: string;
  voidOperationId: string;
  paymentOperationId: string;
  authorizationId: string;
  reasonCode: string;
}

export type PaymentVoidCommand = CommandEnvelope<
  typeof PAYMENT_VOID_COMMAND_TYPE,
  PaymentVoidCommandPayload
>;

export interface PaymentReconcileCommandPayload {
  orderId: string;
  reconciliationOperationId: string;
  paymentOperationId: string;
}

export type PaymentReconcileCommand = CommandEnvelope<
  typeof PAYMENT_RECONCILE_COMMAND_TYPE,
  PaymentReconcileCommandPayload
>;

export interface PaymentAuthorizedPayload {
  paymentId: string;
  orderId: string;
  paymentOperationId: string;
  authorizationId: string;
  amount: string;
  currency: string;
  providerReference: string | null;
}

export type PaymentAuthorizedEvent = EventEnvelope<
  typeof PAYMENT_AUTHORIZED_EVENT_TYPE,
  PaymentAuthorizedPayload
>;

export interface PaymentCaptureCommandPayload {
  orderId: string;
  captureOperationId: string;
  paymentOperationId: string;
  amount: string;
  currency: string;
}

export type PaymentCaptureCommand = CommandEnvelope<
  typeof PAYMENT_CAPTURE_COMMAND_TYPE,
  PaymentCaptureCommandPayload
>;

export interface PaymentCapturedPayload {
  paymentId: string;
  orderId: string;
  paymentOperationId: string;
  captureOperationId: string;
  captureId: string;
  amount: string;
  currency: string;
}

export type PaymentCapturedEvent = EventEnvelope<
  typeof PAYMENT_CAPTURED_EVENT_TYPE,
  PaymentCapturedPayload
>;

export interface PaymentCaptureFailedPayload {
  paymentId: string;
  orderId: string;
  paymentOperationId: string;
  captureOperationId: string;
  amount: string;
  currency: string;
  reasonCode: string;
  reason: string;
}

export type PaymentCaptureFailedEvent = EventEnvelope<
  typeof PAYMENT_CAPTURE_FAILED_EVENT_TYPE,
  PaymentCaptureFailedPayload
>;

export interface PaymentAuthorizationFailedPayload {
  paymentId: string;
  orderId: string;
  paymentOperationId: string;
  amount: string;
  currency: string;
  reasonCode: string;
  reason: string;
}

export type PaymentAuthorizationFailedEvent = EventEnvelope<
  typeof PAYMENT_AUTHORIZATION_FAILED_EVENT_TYPE,
  PaymentAuthorizationFailedPayload
>;

export interface PaymentRefundedPayload {
  paymentId: string;
  orderId: string;
  sagaId: string;
  paymentOperationId: string;
  refundOperationId: string;
  refundId: string;
  amount: string;
  currency: string;
  providerReference: string | null;
}

export type PaymentRefundedEvent = EventEnvelope<
  typeof PAYMENT_REFUNDED_EVENT_TYPE,
  PaymentRefundedPayload
>;

export interface PaymentRefundFailedPayload {
  paymentId: string;
  orderId: string;
  sagaId: string;
  paymentOperationId: string;
  refundOperationId: string;
  amount: string;
  currency: string;
  reasonCode: string;
  reason: string;
}

export type PaymentRefundFailedEvent = EventEnvelope<
  typeof PAYMENT_REFUND_FAILED_EVENT_TYPE,
  PaymentRefundFailedPayload
>;

export interface PaymentVoidedPayload {
  paymentId: string;
  orderId: string;
  sagaId: string;
  paymentOperationId: string;
  voidOperationId: string;
  authorizationId: string;
  providerReference: string | null;
}

export type PaymentVoidedEvent = EventEnvelope<
  typeof PAYMENT_VOIDED_EVENT_TYPE,
  PaymentVoidedPayload
>;

export interface PaymentVoidFailedPayload {
  paymentId: string;
  orderId: string;
  sagaId: string;
  paymentOperationId: string;
  voidOperationId: string;
  reasonCode: string;
  reason: string;
}

export type PaymentVoidFailedEvent = EventEnvelope<
  typeof PAYMENT_VOID_FAILED_EVENT_TYPE,
  PaymentVoidFailedPayload
>;

export interface PaymentAuthorizationUncertainPayload {
  orderId: string;
  paymentOperationId: string;
  reasonCode: string;
  reason: string;
}

export type PaymentAuthorizationUncertainEvent = EventEnvelope<
  typeof PAYMENT_AUTHORIZATION_UNCERTAIN_EVENT_TYPE,
  PaymentAuthorizationUncertainPayload
>;

export type PaymentReconciliationStatus =
  'AUTHORIZED' | 'NOT_AUTHORIZED' | 'CAPTURED' | 'PENDING' | 'UNKNOWN';

export interface PaymentReconciledPayload {
  orderId: string;
  paymentOperationId: string;
  reconciliationCommandId: string;
  status: PaymentReconciliationStatus;
  authorizationId: string | null;
  reasonCode: string | null;
  reason: string | null;
}

export type PaymentReconciledEvent = EventEnvelope<
  typeof PAYMENT_RECONCILED_EVENT_TYPE,
  PaymentReconciledPayload
>;

export type InventoryEvent =
  | InventoryReservedEvent
  | InventoryReservationFailedEvent
  | InventoryReleasedEvent
  | InventoryReleaseFailedEvent;

export type PaymentEvent =
  | PaymentAuthorizedEvent
  | PaymentAuthorizationFailedEvent
  | PaymentCapturedEvent
  | PaymentCaptureFailedEvent
  | PaymentAuthorizationUncertainEvent
  | PaymentRefundedEvent
  | PaymentRefundFailedEvent
  | PaymentVoidedEvent
  | PaymentVoidFailedEvent
  | PaymentReconciledEvent;

export type PaymentCommand =
  | PaymentAuthorizeCommand
  | PaymentCaptureCommand
  | PaymentRefundCommand
  | PaymentVoidCommand
  | PaymentReconcileCommand;

export type OrderServiceEvent =
  | OrderCreatedEvent
  | OrderConfirmedEvent
  | OrderCancelledEvent;
