export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function dayNumber(s: string): number {
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / 86_400_000);
}

export function addDays(s: string, days: number): string {
  return new Date((dayNumber(s) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** Today's date in Lima (UTC-5, no DST) for a given epoch-ms instant. */
export function limaDate(nowMs: number): string {
  return new Date(nowMs - 5 * 3_600_000).toISOString().slice(0, 10);
}
