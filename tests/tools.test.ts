import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitIgv } from "../src/money.js";
import { AS_OF, callTool, startEnv, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.close();
});

describe("seed data sanity", () => {
  it("every sale total equals the sum of its lines (integer cents)", () => {
    const bad = env.db
      .prepare(
        `SELECT s.id FROM sales s
         JOIN sale_items i ON i.sale_id = s.id
         GROUP BY s.id HAVING SUM(i.quantity * i.unit_price_cents) != s.total_cents`,
      )
      .all();
    expect(bad).toEqual([]);
  });

  it("covers about two months of history", () => {
    const r = env.db.prepare("SELECT MIN(sale_date) AS a, MAX(sale_date) AS b FROM sales").get() as { a: string; b: string };
    expect(r.a).toBe("2026-01-15");
    expect(r.b).toBe(AS_OF);
  });
});

describe("tool results", () => {
  it("get_sales_summary: base + igv == total and matches an independent SQL computation", async () => {
    const r = await callTool(env, env.keyA, "get_sales_summary", { from: "2026-03-01", to: AS_OF });
    const d = r.data;
    expect(d.currency).toBe("PEN");
    expect(d.taxableBase.cents + d.igv.cents).toBe(d.total.cents);
    const rows = env.db
      .prepare("SELECT total_cents AS t FROM sales WHERE tenant_id='cafe-arequipa' AND sale_date BETWEEN '2026-03-01' AND ?")
      .all(AS_OF) as { t: number }[];
    expect(d.documents).toBe(rows.length);
    expect(d.total.cents).toBe(rows.reduce((s, x) => s + x.t, 0));
    expect(d.igv.cents).toBe(rows.reduce((s, x) => s + splitIgv(x.t).tax, 0));
    const methods = d.byPaymentMethod.reduce((s: number, m: { total: { cents: number } }) => s + m.total.cents, 0);
    expect(methods).toBe(d.total.cents);
    expect(d.total.display).toMatch(/^S\/ [\d,]+\.\d{2}$/);
  });

  it("get_sales_summary on an empty range returns zeros", async () => {
    const r = await callTool(env, env.keyA, "get_sales_summary", { from: "2030-01-01", to: "2030-01-02" });
    expect(r.data.documents).toBe(0);
    expect(r.data.total.cents).toBe(0);
    expect(r.data.averageTicket.cents).toBe(0);
  });

  it("get_top_products: sorted by revenue, respects limit", async () => {
    const r = await callTool(env, env.keyB, "get_top_products", { from: "2026-01-01", to: AS_OF, limit: 3 });
    const revenues = r.data.products.map((p: { revenue: { cents: number } }) => p.revenue.cents);
    expect(revenues).toHaveLength(3);
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues);
    expect(r.data.currency).toBe("USD");
  });

  it("get_low_stock_products: the seeded low-stock items show up, lowest first", async () => {
    const r = await callTool(env, env.keyA, "get_low_stock_products", { threshold: 5 });
    const names = r.data.products.map((p: { name: string }) => p.name);
    expect(names).toEqual(["Bottled water", "Arequipa beans 1kg", "Butter croissant"]);
  });

  it("get_cash_register_status: expected cash = opening + cash sales + in - out", async () => {
    const r = await callTool(env, env.keyA, "get_cash_register_status");
    const c = r.data;
    expect(c.status).toBe("open");
    expect(c.expectedCash.cents).toBe(
      c.opening.cents + c.cashSalesToday.cents + c.manualCashIn.cents - c.manualCashOut.cents,
    );
    expect(c.manualCashOut.cents).toBe(15_500);
  });

  it("get_receivables_summary: overdue figures are consistent with the listing", async () => {
    const s = (await callTool(env, env.keyB, "get_receivables_summary")).data;
    const list = (await callTool(env, env.keyB, "list_receivables", { pageSize: 50 })).data;
    const overdue = list.invoices.filter((i: { daysOverdue: number }) => i.daysOverdue > 0);
    expect(s.overdueInvoices).toBe(overdue.length);
    expect(s.overdueAmount.cents).toBe(overdue.reduce((a: number, i: { outstanding: { cents: number } }) => a + i.outstanding.cents, 0));
    expect(s.invoices).toBe(list.totalOpenInvoices);
    expect(s.oldestOverdueDays).toBe(45);
    const only = (await callTool(env, env.keyB, "get_receivables_summary", { overdueOnly: true })).data;
    expect(only.invoices).toBe(s.overdueInvoices);
    expect(only.outstanding.cents).toBe(s.overdueAmount.cents);
  });

  it("list_receivables paginates without gaps or repeats", async () => {
    const all = (await callTool(env, env.keyB, "list_receivables", { pageSize: 50 })).data.invoices;
    const pages: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const r = (await callTool(env, env.keyB, "list_receivables", { page, pageSize: 3 })).data;
      pages.push(...r.invoices.map((i: { document: string }) => i.document));
    }
    expect(pages).toEqual(all.map((i: { document: string }) => i.document));
  });

  it("search_products matches by SKU or name, case-insensitively", async () => {
    expect((await callTool(env, env.keyB, "search_products", { query: "pc-006" })).data.products[0].name).toBe("SSD 1TB NVMe");
    expect((await callTool(env, env.keyA, "search_products", { query: "BEANS" })).data.count).toBe(2);
  });
});

describe("official MCP client over Streamable HTTP", () => {
  it("connects, lists tools and calls one end to end", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${env.keyA}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(7);
      const res = await client.callTool({ name: "search_products", arguments: { query: "espresso" } });
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      expect(JSON.parse(text).products[0].name).toBe("Espresso");
    } finally {
      await client.close();
    }
  });
});
