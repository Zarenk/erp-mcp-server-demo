/**
 * Money is always an integer number of cents. Floats never touch an amount.
 * Peruvian retail prices include IGV (18%), so we split a gross total into
 * base + tax instead of adding tax on top.
 */
export type Currency = "PEN" | "USD";

/** IGV rate in basis points (1800 = 18.00%). */
export const IGV_RATE_BPS = 1800;

const MAX_CENTS = 10 ** 11; // keeps 2 * cents * 10_000 inside Number.MAX_SAFE_INTEGER

export function assertCents(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_CENTS) {
    throw new RangeError(`invalid amount in cents: ${value}`);
  }
}

export interface IgvSplit {
  base: number;
  tax: number;
  total: number;
}

/**
 * Splits a gross (IGV-included) total. `base` is rounded half-up and `tax` is the
 * remainder, so base + tax === total always holds, for every single document.
 */
export function splitIgv(totalCents: number, rateBps: number = IGV_RATE_BPS): IgvSplit {
  assertCents(totalCents);
  const divisor = 10_000 + rateBps;
  const base = Math.floor((2 * totalCents * 10_000 + divisor) / (2 * divisor));
  return { base, tax: totalCents - base, total: totalCents };
}

export function sumCents(values: Iterable<number>): number {
  let sum = 0;
  for (const v of values) {
    assertCents(v);
    sum += v;
  }
  return sum;
}

/** Integer average, rounded half-up. */
export function averageCents(totalCents: number, count: number): number {
  if (count <= 0) return 0;
  return Math.floor((2 * totalCents + count) / (2 * count));
}

const SYMBOLS: Record<Currency, string> = { PEN: "S/ ", USD: "US$ " };

export function formatMoney(cents: number, currency: Currency): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (cents % 100).toString().padStart(2, "0");
  return `${SYMBOLS[currency]}${whole}.${frac}`;
}

export interface Money {
  cents: number;
  display: string;
}

export function money(cents: number, currency: Currency): Money {
  return { cents, display: formatMoney(cents, currency) };
}
