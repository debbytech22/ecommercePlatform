export interface OrderConfirmedEmailData {
  orderId: string;
  customerId: string;
  amount: string;
  currency: string;
  confirmedAt: string;
}

export const TEMPLATE_KEY = 'email:order-confirmed:v1';

export function render(data: OrderConfirmedEmailData): { subject: string; body: string } {
  const amount = formatAmount(data.amount, data.currency);
  return {
    subject: `Your order ${escape(data.orderId)} is confirmed`,
    body: [
      `Thank you for your order.`,
      ``,
      `Order ID: ${escape(data.orderId)}`,
      `Amount charged: ${amount}`,
      `Confirmed at: ${formatDate(data.confirmedAt)}`,
      ``,
      `We will notify you when your order ships.`,
    ].join('\n'),
  };
}

function formatAmount(amount: string, currency: string): string {
  const numeric = parseFloat(amount);
  if (isNaN(numeric)) return `${amount} ${currency}`;
  return `${numeric.toFixed(2)} ${currency.toUpperCase()}`;
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
