/**
 * Redacts an email address or phone number for safe structured logging.
 * Email: user@example.com → u***@example.com
 * Phone: +2348012345678  → +234*****5678
 */
export function redactAddress(value: string): string {
  if (!value) return '[redacted]';
  if (value.includes('@')) return redactEmail(value);
  if (/^\+?\d/.test(value)) return redactPhone(value);
  return '[redacted]';
}

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '[redacted]';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, 1);
  return `${visible}***${domain}`;
}

function redactPhone(phone: string): string {
  if (phone.length < 6) return '[redacted]';
  const last4 = phone.slice(-4);
  const prefix = phone.slice(0, Math.min(4, phone.length - 4));
  const stars = '*'.repeat(Math.max(0, phone.length - prefix.length - 4));
  return `${prefix}${stars}${last4}`;
}
