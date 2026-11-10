import { z } from "zod";
import type { Db } from "./db.js";
import { isValidDate, dayNumber } from "./dates.js";
import { money, type Currency } from "./money.js";
import * as repo from "./repo.js";

/**
 * The tool whitelist. Everything the model can do is listed here, and all of it is read-only.
 * Inputs are strict schemas: unknown properties (for example an attempted `organizationId`)
 * are rejected, never ignored silently.
 */

export interface ToolContext {
  db: Db;
  /** Comes from the API key record. Tools never accept a tenant from their arguments. */
  tenantId: string;
  /** "Today" in Lima, injected so tests are deterministic. */
  today: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  run(ctx: ToolContext, args: never): unknown;
}

const MAX_RANGE_DAYS = 366;

const date = (what: string) =>
  z
    .string()
    .refine(isValidDate, { message: "must be a real date formatted YYYY-MM-DD" })
    .describe(what);

const rangeShape = {
  from: date("First day, inclusive (YYYY-MM-DD)"),
  to: date("Last day, inclusive (YYYY-MM-DD)"),
};

function validRange(v: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (!isValidDate(v.from) || !isValidDate(v.to)) return; // already reported by the field schemas
  const span = dayNumber(v.to) - dayNumber(v.from);
  if (span < 0) ctx.addIssue({ code: "custom", message: "`from` must be on or before `to`", path: ["from"] });
  else if (span >= MAX_RANGE_DAYS)
    ctx.addIssue({ code: "custom", message: `range may not exceed ${MAX_RANGE_DAYS} days`, path: ["to"] });
}

function defineTool<S extends z.ZodType<Record<string, unknown>>>(def: {
  name: string;
  description: string;
  input: S;
  run: (ctx: ToolContext, args: z.infer<S>, currency: Currency) => unknown;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    run: ((ctx: ToolContext, args: z.infer<S>) => {
      const tenant = repo.getTenant(ctx.db, ctx.tenantId);
      if (!tenant) throw new Error("tenant not found");
      return def.run(ctx, args, tenant.currency);
    }) as ToolDef["run"],
  };
}

export const TOOLS: readonly ToolDef[] = [
  defineTool({
    name: "get_sales_summary",
    description:
      "Sales totals for a date range: document count, gross total, IGV (18%) split into base and tax, average ticket and breakdown by payment method.",
    input: z.strictObject(rangeShape).superRefine(validRange),
    run: (ctx, { from, to }, cur) => {
      const s = repo.salesSummary(ctx.db, ctx.tenantId, from, to);
      return {
        currency: cur,
        from,
        to,
        documents: s.count,
        total: money(s.total, cur),
        taxableBase: money(s.base, cur),
        igv: money(s.tax, cur),
        averageTicket: money(s.average, cur),
        byPaymentMethod: s.byMethod.map((m) => ({ method: m.method, documents: m.count, total: money(m.total, cur) })),
      };
    },
  }),
  defineTool({
    name: "get_top_products",
    description: "Best-selling products by revenue in a date range, with units sold.",
    input: z
      .strictObject({
        ...rangeShape,
        limit: z.number().int().min(1).max(20).default(5).describe("How many products to return (1-20, default 5)"),
      })
      .superRefine(validRange),
    run: (ctx, { from, to, limit }, cur) => ({
      currency: cur,
      from,
      to,
      products: repo.topProducts(ctx.db, ctx.tenantId, from, to, limit).map((p) => ({
        sku: p.sku,
        name: p.name,
        unitsSold: p.units,
        revenue: money(p.revenue, cur),
      })),
    }),
  }),
  defineTool({
    name: "get_low_stock_products",
    description: "Products whose stock is at or below a threshold, lowest first.",
    input: z.strictObject({
      threshold: z.number().int().min(0).max(10_000).default(5).describe("Stock level considered low (default 5)"),
    }),
    run: (ctx, { threshold }) => {
      const rows = repo.lowStock(ctx.db, ctx.tenantId, threshold);
      return { threshold, count: rows.length, products: rows.map((p) => ({ sku: p.sku, name: p.name, stock: p.stock })) };
    },
  }),
  defineTool({
    name: "get_cash_register_status",
    description:
      "Today's cash register: status, opening amount, cash sales, manual cash in/out and the expected cash in drawer.",
    input: z.strictObject({}),
    run: (ctx, _args, cur) => {
      const c = repo.cashStatus(ctx.db, ctx.tenantId, ctx.today);
      if (!c) return { currency: cur, status: "no cash register configured" };
      return {
        currency: cur,
        date: ctx.today,
        status: c.status,
        openedOn: c.openedOn,
        opening: money(c.opening, cur),
        cashSalesToday: money(c.cashSales, cur),
        manualCashIn: money(c.moneyIn, cur),
        manualCashOut: money(c.moneyOut, cur),
        expectedCash: money(c.expectedCash, cur),
      };
    },
  }),
  defineTool({
    name: "get_receivables_summary",
    description: "Accounts receivable totals: outstanding amount, how much is overdue and how old the oldest overdue invoice is.",
    input: z.strictObject({
      overdueOnly: z.boolean().default(false).describe("Count only overdue invoices in `count` and `outstanding`"),
    }),
    run: (ctx, { overdueOnly }, cur) => {
      const r = repo.receivablesSummary(ctx.db, ctx.tenantId, ctx.today, overdueOnly);
      return {
        currency: cur,
        asOf: ctx.today,
        overdueOnly,
        invoices: r.count,
        outstanding: money(r.outstanding, cur),
        overdueInvoices: r.overdueCount,
        overdueAmount: money(r.overdueAmount, cur),
        oldestOverdueDays: r.oldestOverdueDays,
      };
    },
  }),
  defineTool({
    name: "list_receivables",
    description: "Open invoices owed by customers, oldest due date first, paginated.",
    input: z.strictObject({
      page: z.number().int().min(1).max(10_000).default(1).describe("1-based page number"),
      pageSize: z.number().int().min(1).max(50).default(10).describe("Rows per page (1-50, default 10)"),
    }),
    run: (ctx, { page, pageSize }, cur) => {
      const r = repo.listReceivables(ctx.db, ctx.tenantId, ctx.today, page, pageSize);
      return {
        currency: cur,
        page,
        pageSize,
        totalOpenInvoices: r.total,
        invoices: r.rows.map((x) => ({
          document: x.document,
          customer: x.customer,
          outstanding: money(x.outstanding, cur),
          dueDate: x.dueDate,
          daysOverdue: x.daysOverdue,
        })),
      };
    },
  }),
  defineTool({
    name: "search_products",
    description: "Find products by name or SKU (case-insensitive substring), with price and stock. Max 20 results.",
    input: z.strictObject({
      query: z.string().trim().min(2).max(50).describe("Text to look for in the product name or SKU"),
    }),
    run: (ctx, { query }, cur) => {
      const rows = repo.searchProducts(ctx.db, ctx.tenantId, query);
      return {
        currency: cur,
        count: rows.length,
        products: rows.map((p) => ({ sku: p.sku, name: p.name, price: money(p.price, cur), stock: p.stock })),
      };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** JSON Schema advertised to clients via tools/list (generated from the same schema used to validate). */
export function jsonSchemaFor(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}
