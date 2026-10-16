// Shared formatting utilities for currency, numbers, and percentages

export function formatCurrency(value: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value);
}

export function formatLargeNumber(value: number): string {
  if (value >= 1e12) {
    return `$${(value / 1e12).toFixed(2)}T`;
  }
  if (value >= 1e9) {
    return `$${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `$${(value / 1e6).toFixed(2)}M`;
  }
  return formatCurrency(value);
}

export function formatPercentage(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

const USD_2DP = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Signed dollars with a true minus sign: +$1,234.50 / −$88.10 / $0.00; "—" when missing. */
export function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = USD_2DP.format(Math.abs(value));
  return value < 0 ? `−${s}` : value > 0 ? `+${s}` : s;
}

/** Signed percent from a fraction (0.123 → +12.3%); "—" when missing. */
export function formatSignedFraction(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(digits)}%`;
}

/** Signed basis points: +12.3 bps / −4.0 bps; "—" when missing. */
export function formatBps(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)} bps`;
}
