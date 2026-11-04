export interface OrderCancelledEmailData {
  orderId: string;
  customerId: string;
  reasonCode: string;
  cancelledAt: string;
}

export const TEMPLATE_KEY = 'email:order-cancelled:v1';

export function render(data: OrderCancelledEmailData): { subject: string; body: string } {
  return {
    subject: `Your order ${escape(data.orderId)} has been cancelled`,
    body: [
      `We're sorry to let you know that your order has been cancelled.`,
      ``,
      `Order ID: ${escape(data.orderId)}`,
      `Cancelled at: ${formatDate(data.cancelledAt)}`,
      ``,
      `If you were charged, a refund will be processed within 5–10 business days.`,
      `If you have questions, please contact our support team.`,
    ].join('\n'),
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toUTCString();
}

function escape(value: string): string {
  return value.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}
