import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repo from "../src/repo.js";
import { AS_OF, callTool, startEnv, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.close();
});

const RANGE = { from: "2026-01-01", to: AS_OF };
const CALLS: [string, Record<string, unknown>][] = [
  ["get_sales_summary", RANGE],
  ["get_top_products", { ...RANGE, limit: 20 }],
  ["get_low_stock_products", { threshold: 10_000 }],
  ["get_cash_register_status", {}],
  ["get_receivables_summary", {}],
  ["list_receivables", { pageSize: 50 }],
  ["search_products", { query: "es" }],
];

// Markers that exist in exactly one tenant's fake data.
const CAFE_MARKERS = ["CAF-", "Espresso", "Misti", "Andes Mining", "Hotel Plaza"];
const COMPU_MARKERS = ["PC-", "Laptop", "CompuNorte", "Estudio Contable", "Webcam"];

describe("tenant isolation", () => {
  it("each key only ever sees its own tenant's data, across every tool", async () => {
    for (const [name, args] of CALLS) {
      const a = JSON.stringify((await callTool(env, env.keyA, name, args)).data);
      const b = JSON.stringify((await callTool(env, env.keyB, name, args)).data);
      for (const m of COMPU_MARKERS) expect(a, `${name} leaked ${m} to tenant A`).not.toContain(m);
      for (const m of CAFE_MARKERS) expect(b, `${name} leaked ${m} to tenant B`).not.toContain(m);
    }
  });

  it("returns the tenant's own currency (PEN for the cafe, USD for the computer store)", async () => {
    expect((await callTool(env, env.keyA, "get_cash_register_status")).data.currency).toBe("PEN");
    expect((await callTool(env, env.keyB, "get_cash_register_status")).data.currency).toBe("USD");
  });

  it("searching for the other tenant's product finds nothing", async () => {
    expect((await callTool(env, env.keyA, "search_products", { query: "Laptop" })).data.count).toBe(0);
    expect((await callTool(env, env.keyB, "search_products", { query: "Espresso" })).data.count).toBe(0);
    expect((await callTool(env, env.keyB, "search_products", { query: "Laptop" })).data.count).toBeGreaterThan(0);
  });

  it("ignores spoofed tenant headers: the tenant comes only from the key record", async () => {
    const spoof = {
      "x-org-id": "compu-lima",
      "x-company-id": "compu-lima",
      "x-tenant-id": "compu-lima",
      "x-forwarded-user": "owner@compu-lima",
    };
    const plain = await callTool(env, env.keyA, "get_sales_summary", RANGE);
    const spoofed = await callTool(env, env.keyA, "get_sales_summary", RANGE, spoof);
    expect(spoofed.data).toEqual(plain.data);
    expect(spoofed.data.currency).toBe("PEN");
    const stock = JSON.stringify((await callTool(env, env.keyA, "get_low_stock_products", { threshold: 100 }, spoof)).data);
    expect(stock).not.toContain("PC-");
  });

  it("rejects tenant selectors smuggled in tool arguments", async () => {
    for (const extra of [{ organizationId: "compu-lima" }, { tenantId: "compu-lima" }, { companyId: 2 }]) {
      const r = await callTool(env, env.keyA, "get_low_stock_products", { threshold: 3, ...extra });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Invalid arguments/);
    }
  });

  it("repository functions return nothing for a tenant that has no data", () => {
    const ghost = "ghost-tenant";
    expect(repo.salesSummary(env.db, ghost, "2020-01-01", "2030-01-01").count).toBe(0);
    expect(repo.topProducts(env.db, ghost, "2020-01-01", "2030-01-01", 20)).toEqual([]);
    expect(repo.lowStock(env.db, ghost, 10_000)).toEqual([]);
    expect(repo.searchProducts(env.db, ghost, "a")).toEqual([]);
    expect(repo.cashStatus(env.db, ghost, AS_OF)).toBeUndefined();
    expect(repo.receivablesSummary(env.db, ghost, AS_OF, false).count).toBe(0);
    expect(repo.listReceivables(env.db, ghost, AS_OF, 1, 50).total).toBe(0);
  });

  it("per-tenant totals add up to the global totals (nothing double counted or lost)", () => {
    const ids = ["cafe-arequipa", "compu-lima"];
    const sum = ids.reduce((s, id) => s + repo.salesSummary(env.db, id, "2020-01-01", "2030-01-01").total, 0);
    const global = (env.db.prepare("SELECT SUM(total_cents) AS v FROM sales").get() as { v: number }).v;
    expect(sum).toBe(global);
  });
});
