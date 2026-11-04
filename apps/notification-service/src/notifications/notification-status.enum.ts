export enum NotificationStatus {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  BOUNCED = 'BOUNCED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  PUSH = 'PUSH',
}

export enum NotificationType {
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
}

export enum NotificationCategory {
  TRANSACTIONAL = 'TRANSACTIONAL',
  MARKETING = 'MARKETING',
}

export enum DeliveryAttemptStatus {
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/** Terminal statuses — no further delivery attempts should be made. */
export const TERMINAL_STATUSES = new Set<NotificationStatus>([
  NotificationStatus.SENT,
  NotificationStatus.DELIVERED,
  NotificationStatus.FAILED,
  NotificationStatus.BOUNCED,
  NotificationStatus.REJECTED,
  NotificationStatus.CANCELLED,
]);
