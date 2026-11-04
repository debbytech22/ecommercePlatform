import { calculateLineTotal, formatMoney, parseMoney } from './money';

describe('order money precision', () => {
  it('accepts the full DECIMAL(19,4) range', () => {
    const maximum = '999999999999999.9999';

    expect(formatMoney(parseMoney(maximum))).toBe(maximum);
  });

  it('rejects values beyond DECIMAL(19,4)', () => {
    expect(() => parseMoney('1000000000000000')).toThrow();
    expect(() => calculateLineTotal('999999999999999.9999', 2)).toThrow();
  });

  it('calculates line totals without floating-point rounding', () => {
    expect(calculateLineTotal('0.1001', 3)).toBe('0.3003');
  });
});
