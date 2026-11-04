const SCALE = 10_000n;
const MAX_DECIMAL_19_4 = 9_999_999_999_999_999_999n;

export function parseMoney(value: string): bigint {
  // Require a canonical, non-negative decimal with at most 4 fractional
  // digits. Exponents, signs, NaN and whitespace are rejected.
  if (!/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/.test(value)) {
    throw new Error(`Invalid monetary value: ${value}`);
  }

  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));

  if (scaled > MAX_DECIMAL_19_4) {
    throw new Error('Monetary value exceeds DECIMAL(19,4) capacity');
  }

  return scaled;
}

export function formatMoney(value: bigint): string {
  if (value < 0n || value > MAX_DECIMAL_19_4) {
    throw new Error('Monetary result is outside DECIMAL(19,4) capacity');
  }

  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(4, '0');

  return `${whole}.${fraction}`;
}

export function calculateLineTotal(
  unitPrice: string,
  quantity: number,
): string {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new Error('Quantity must be an integer between 1 and 1000');
  }

  return formatMoney(parseMoney(unitPrice) * BigInt(quantity));
}
