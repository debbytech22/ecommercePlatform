export interface OrderConfirmedSmsData {
  orderId: string;
  amount: string;
  currency: string;
}

export const TEMPLATE_KEY = 'sms:order-confirmed:v1';

export function render(data: OrderConfirmedSmsData): { subject: string; body: string } {
  const amount = formatAmount(data.amount, data.currency);
  return {
    subject: `Order ${data.orderId} confirmed`,
    body: `Your order ${data.orderId} is confirmed. Amount: ${amount}. We'll notify you when it ships.`,
  };
}

function formatAmount(amount: string, currency: string): string {
  const numeric = parseFloat(amount);
  return isNaN(numeric) ? `${amount} ${currency}` : `${numeric.toFixed(2)} ${currency.toUpperCase()}`;
}
