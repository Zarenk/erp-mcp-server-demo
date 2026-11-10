import type { Db } from "./db.js";
import type { Currency } from "./money.js";
import { averageCents, splitIgv, sumCents } from "./money.js";
import { dayNumber } from "./dates.js";

/**
 * Read-only data access. EVERY function takes `tenantId` as its first argument and
 * puts it in the WHERE clause; there is no query in this file without a tenant filter.
 * The tenant id is supplied by the auth layer (from the API key record), never by the client.
 */

export function getTenant(db: Db, tenantId: string) {
  return db
    .prepare("SELECT id, name, city, currency FROM tenants WHERE id = ?")
    .get(tenantId) as { id: string; name: string; city: string; currency: Currency } | undefined;
}

export function salesSummary(db: Db, tenantId: string, from: string, to: string) {
  const rows = db
    .prepare(
      `SELECT total_cents AS total, payment_method AS method FROM sales
       WHERE tenant_id = ? AND sale_date BETWEEN ? AND ?`,
    )
    .all(tenantId, from, to) as { total: number; method: string }[];

  let base = 0;
  let tax = 0;
  const byMethod = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const s = splitIgv(r.total); // per document, like a real invoice
    base += s.base;
    tax += s.tax;
    const m = byMethod.get(r.method) ?? { count: 0, total: 0 };
    m.count += 1;
    m.total += r.total;
    byMethod.set(r.method, m);
  }
  const total = sumCents(rows.map((r) => r.total));
  return {
    count: rows.length,
    total,
    base,
    tax,
    average: averageCents(total, rows.length),
    byMethod: [...byMethod.entries()]
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.total - a.total),
  };
}

export function topProducts(db: Db, tenantId: string, from: string, to: string, limit: number) {
  return db
    .prepare(
      `SELECT p.id, p.sku, p.name,
              SUM(si.quantity) AS units,
              SUM(si.quantity * si.unit_price_cents) AS revenue
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE s.tenant_id = ? AND p.tenant_id = ? AND s.sale_date BETWEEN ? AND ?
       GROUP BY p.id
       ORDER BY revenue DESC, p.id
       LIMIT ?`,
    )
    .all(tenantId, tenantId, from, to, limit) as {
    id: number;
    sku: string;
    name: string;
    units: number;
    revenue: number;
  }[];
}

export function lowStock(db: Db, tenantId: string, threshold: number) {
  return db
    .prepare(
      `SELECT id, sku, name, stock FROM products
       WHERE tenant_id = ? AND stock <= ? ORDER BY stock, id`,
    )
    .all(tenantId, threshold) as { id: number; sku: string; name: string; stock: number }[];
}

export function searchProducts(db: Db, tenantId: string, query: string, limit = 20) {
  const escaped = query.replace(/[\\%_]/g, (c) => "\\" + c);
  const like = `%${escaped}%`;
  return db
    .prepare(
      `SELECT id, sku, name, price_cents AS price, stock FROM products
       WHERE tenant_id = ? AND (name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')
       ORDER BY name LIMIT ?`,
    )
    .all(tenantId, like, like, limit) as {
    id: number;
    sku: string;
    name: string;
    price: number;
    stock: number;
  }[];
}

export function cashStatus(db: Db, tenantId: string, today: string) {
  const reg = db
    .prepare(
      "SELECT status, opened_on AS openedOn, opening_cents AS opening FROM cash_registers WHERE tenant_id = ?",
    )
    .get(tenantId) as { status: "open" | "closed"; openedOn: string; opening: number } | undefined;
  if (!reg) return undefined;
  const cashSales = db
    .prepare(
      `SELECT COALESCE(SUM(total_cents),0) AS v FROM sales
       WHERE tenant_id = ? AND sale_date = ? AND payment_method = 'cash'`,
    )
    .get(tenantId, today) as { v: number };
  const movement = (kind: "in" | "out") =>
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents),0) AS v FROM cash_movements WHERE tenant_id = ? AND move_date = ? AND kind = ?",
        )
        .get(tenantId, today, kind) as { v: number }
    ).v;
  const moneyIn = movement("in");
  const moneyOut = movement("out");
  return {
    ...reg,
    cashSales: cashSales.v,
    moneyIn,
    moneyOut,
    expectedCash: reg.opening + cashSales.v + moneyIn - moneyOut,
  };
}

interface ReceivableRow {
  id: number;
  customer: string;
  document: string;
  outstanding: number;
  dueDate: string;
}

const OUTSTANDING_SQL = `SELECT id, customer, document, (amount_cents - paid_cents) AS outstanding, due_date AS dueDate
  FROM receivables WHERE tenant_id = ? AND amount_cents > paid_cents`;

export function receivablesSummary(db: Db, tenantId: string, today: string, overdueOnly: boolean) {
  const all = db.prepare(OUTSTANDING_SQL).all(tenantId) as ReceivableRow[];
  const overdue = all.filter((r) => r.dueDate < today);
  const rows = overdueOnly ? overdue : all;
  const oldest = overdue.reduce<ReceivableRow | undefined>(
    (acc, r) => (!acc || r.dueDate < acc.dueDate ? r : acc),
    undefined,
  );
  return {
    count: rows.length,
    outstanding: sumCents(rows.map((r) => r.outstanding)),
    overdueCount: overdue.length,
    overdueAmount: sumCents(overdue.map((r) => r.outstanding)),
    oldestOverdueDays: oldest ? dayNumber(today) - dayNumber(oldest.dueDate) : 0,
  };
}

export function listReceivables(db: Db, tenantId: string, today: string, page: number, pageSize: number) {
  const total = (
    db
      .prepare("SELECT COUNT(*) AS n FROM receivables WHERE tenant_id = ? AND amount_cents > paid_cents")
      .get(tenantId) as { n: number }
  ).n;
  const rows = db
    .prepare(`${OUTSTANDING_SQL} ORDER BY due_date, id LIMIT ? OFFSET ?`)
    .all(tenantId, pageSize, (page - 1) * pageSize) as ReceivableRow[];
  return {
    total,
    rows: rows.map((r) => ({ ...r, daysOverdue: Math.max(0, dayNumber(today) - dayNumber(r.dueDate)) })),
  };
}
