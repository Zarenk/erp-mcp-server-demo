import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { averageCents, formatMoney, splitIgv, sumCents } from "../src/money.js";

const cents = fc.integer({ min: 0, max: 10 ** 9 });

describe("splitIgv (examples)", () => {
  it("splits a round gross amount exactly", () => {
    expect(splitIgv(11_800)).toEqual({ base: 10_000, tax: 1_800, total: 11_800 });
  });
  it("rounds the base half-up and gives the remainder to tax", () => {
    // 100 / 1.18 = 84.745... -> 85 ; tax = 15
    expect(splitIgv(100)).toEqual({ base: 85, tax: 15, total: 100 });
    expect(splitIgv(0)).toEqual({ base: 0, tax: 0, total: 0 });
  });
  it("rejects floats, negatives and absurd values", () => {
    expect(() => splitIgv(10.5)).toThrow(RangeError);
    expect(() => splitIgv(-1)).toThrow(RangeError);
    expect(() => splitIgv(Number.NaN)).toThrow(RangeError);
    expect(() => splitIgv(10 ** 12)).toThrow(RangeError);
  });
});

describe("money properties (fast-check)", () => {
  it("base + tax === total for any amount", () => {
    fc.assert(
      fc.property(cents, (total) => {
        const s = splitIgv(total);
        expect(s.base + s.tax).toBe(s.total);
        expect(Number.isInteger(s.base) && Number.isInteger(s.tax)).toBe(true);
      }),
    );
  });

  it("tax is never negative and base never exceeds the total", () => {
    fc.assert(
      fc.property(cents, (total) => {
        const s = splitIgv(total);
        expect(s.tax).toBeGreaterThanOrEqual(0);
        expect(s.base).toBeLessThanOrEqual(total);
      }),
    );
  });

  it("tax is within half a cent of the exact 18/118 share", () => {
    fc.assert(
      fc.property(cents, (total) => {
        const exactTax = (total * 1800) / 11800;
        expect(Math.abs(splitIgv(total).tax - exactTax)).toBeLessThanOrEqual(0.5 + 1e-6);
      }),
    );
  });

  it("is monotonic: a bigger total never yields a smaller base", () => {
    fc.assert(
      fc.property(cents, cents, (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(splitIgv(lo).base).toBeLessThanOrEqual(splitIgv(hi).base);
      }),
    );
  });

  it("summing per-document splits equals the split sums (no drift in a period total)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 5_000_000 }), { maxLength: 200 }), (totals) => {
        const splits = totals.map((t) => splitIgv(t));
        const base = splits.reduce((s, x) => s + x.base, 0);
        const tax = splits.reduce((s, x) => s + x.tax, 0);
        expect(base + tax).toBe(sumCents(totals));
      }),
    );
  });

  it("sumCents is order independent", () => {
    fc.assert(
      fc.property(fc.array(cents, { maxLength: 50 }), (xs) => {
        expect(sumCents(xs)).toBe(sumCents([...xs].reverse()));
      }),
    );
  });

  it("averageCents lies between min and max and times count is close to the total", () => {
    fc.assert(
      fc.property(fc.array(cents, { minLength: 1, maxLength: 50 }), (xs) => {
        const avg = averageCents(sumCents(xs), xs.length);
        expect(avg).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(avg).toBeLessThanOrEqual(Math.max(...xs));
        expect(Math.abs(avg * xs.length - sumCents(xs))).toBeLessThanOrEqual(xs.length / 2);
      }),
    );
  });

  it("formatMoney round-trips to the same number of cents", () => {
    fc.assert(
      fc.property(cents, fc.constantFrom("PEN", "USD"), (c, cur) => {
        const text = formatMoney(c, cur);
        const digits = text.replace(/[^0-9.]/g, "");
        const [whole, frac] = digits.split(".") as [string, string];
        expect(frac).toHaveLength(2);
        expect(Number(whole) * 100 + Number(frac)).toBe(c);
      }),
    );
  });
});

describe("formatMoney", () => {
  it("formats with thousands separators", () => {
    expect(formatMoney(123_456_789, "PEN")).toBe("S/ 1,234,567.89");
    expect(formatMoney(5, "USD")).toBe("US$ 0.05");
  });
});
