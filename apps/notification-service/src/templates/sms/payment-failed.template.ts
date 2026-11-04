export interface PaymentFailedSmsData {
  orderId: string;
  amount: string;
  currency: string;
}

export const TEMPLATE_KEY = 'sms:payment-failed:v1';

export function render(data: PaymentFailedSmsData): { subject: string; body: string } {
  const amount = formatAmount(data.amount, data.currency);
  return {
    subject: `Payment failed for order ${data.orderId}`,
    body: `Payment of ${amount} for order ${data.orderId} could not be processed. Please update your payment method.`,
  };
}

function formatAmount(amount: string, currency: string): string {
  const numeric = parseFloat(amount);
  return isNaN(numeric) ? `${amount} ${currency}` : `${numeric.toFixed(2)} ${currency.toUpperCase()}`;
}
