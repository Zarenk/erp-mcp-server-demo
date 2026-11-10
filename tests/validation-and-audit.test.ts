import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, rpc, startEnv, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  env.audit.length = 0;
  env.clock.now = Date.parse("2026-03-15T17:00:00Z");
});

describe("input validation (before execution)", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["get_sales_summary", {}],
    ["get_sales_summary", { from: "2026-02-30", to: "2026-03-01" }],
    ["get_sales_summary", { from: "15/03/2026", to: "2026-03-15" }],
    ["get_sales_summary", { from: "2026-03-15", to: "2026-03-01" }],
    ["get_sales_summary", { from: "2020-01-01", to: "2026-03-01" }],
    ["get_sales_summary", { from: 20260101, to: "2026-03-01" }],
    ["get_top_products", { from: "2026-03-01", to: "2026-03-15", limit: 0 }],
    ["get_top_products", { from: "2026-03-01", to: "2026-03-15", limit: 21 }],
    ["get_top_products", { from: "2026-03-01", to: "2026-03-15", limit: 2.5 }],
    ["get_low_stock_products", { threshold: -1 }],
    ["get_low_stock_products", { threshold: "5" }],
    ["get_receivables_summary", { overdueOnly: "yes" }],
    ["list_receivables", { page: 0 }],
    ["list_receivables", { pageSize: 51 }],
    ["search_products", { query: "a" }],
    ["search_products", { query: "x".repeat(51) }],
    ["search_products", {}],
    ["get_cash_register_status", { anything: 1 }],
  ];

  it.each(invalid)("%s rejects %j", async (name, args) => {
    const r = await callTool(env, env.keyA, name, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Invalid arguments/);
  });

  it("applies defaults when optional arguments are omitted", async () => {
    expect((await callTool(env, env.keyA, "get_low_stock_products")).data.threshold).toBe(5);
    expect((await callTool(env, env.keyA, "list_receivables")).data.pageSize).toBe(10);
    expect((await callTool(env, env.keyA, "get_receivables_summary")).data.overdueOnly).toBe(false);
  });

  it("rejects unknown tools instead of dispatching anything", async () => {
    for (const name of ["delete_sale", "create_sale", "constructor", "__proto__", "toString"]) {
      const r = await callTool(env, env.keyA, name, {});
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Unknown tool.");
    }
  });

  it("treats SQL-looking search text as plain text (parameterized, wildcards escaped)", async () => {
    const r = await callTool(env, env.keyA, "search_products", { query: "'; DROP TABLE products;--" });
    expect(r.isError).toBe(false);
    expect(r.data.count).toBe(0);
    const wild = await callTool(env, env.keyA, "search_products", { query: "%%" });
    expect(wild.data.count).toBe(0); // "%%" is a literal, not "match everything"
    expect((await callTool(env, env.keyA, "search_products", { query: "espresso" })).data.count).toBe(1);
  });

  it("answers malformed JSON with a JSON-RPC parse error, not a stack trace", async () => {
    const res = await fetch(`${env.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.keyA}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});

describe("audit log", () => {
  it("writes one entry per tool call with prefix, org, tool, duration and outcome", async () => {
    await callTool(env, env.keyA, "get_low_stock_products", { threshold: 3 });
    await callTool(env, env.keyB, "list_receivables", { page: 0 }); // invalid -> ok:false
    expect(env.audit).toHaveLength(2);
    const [first, second] = env.audit;
    expect(first).toMatchObject({
      event: "tool_call",
      keyPrefix: env.keyA.slice(0, 8),
      org: "cafe-arequipa",
      tool: "get_low_stock_products",
      ok: true,
    });
    expect(first!.durationMs).toBeGreaterThanOrEqual(0);
    expect(second).toMatchObject({ org: "compu-lima", tool: "list_receivables", ok: false });
  });

  it("never contains the key or the arguments", async () => {
    await callTool(env, env.keyA, "search_products", { query: "SECRET-SEARCH-TERM" });
    await callTool(env, env.keyA, "get_sales_summary", { from: "2026-03-01", to: "2026-03-10" });
    const dump = JSON.stringify(env.audit);
    expect(dump).not.toContain(env.keyA);
    expect(dump).not.toContain(env.keyA.slice(8)); // not even the secret remainder
    expect(dump).not.toContain("SECRET-SEARCH-TERM");
    expect(dump).not.toContain("2026-03-01");
    expect(Object.keys(env.audit[0]!).sort()).toEqual(["durationMs", "event", "keyPrefix", "ok", "org", "tool", "ts"]);
  });

  it("does not echo unknown tool names into the log", async () => {
    await callTool(env, env.keyA, "attacker<script>", {});
    expect(env.audit[0]).toMatchObject({ tool: "(unknown)", ok: false });
  });

  it("does not log non-tool requests (tools/list)", async () => {
    await rpc(env, env.keyA, "tools/list");
    expect(env.audit).toHaveLength(0);
  });
});
