import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEY_RE,
  KeyLimitError,
  UnknownTenantError,
  authenticateKey,
  createApiKey,
  extractBearer,
  generateKey,
  hashKey,
  revokeApiKey,
} from "../src/auth.js";
import { NOW_MS, rpc, startEnv, type Env } from "./helpers.js";

describe("key generation and storage", () => {
  it("generates zx_ + 40 base62 characters, all different", () => {
    const keys = new Set(Array.from({ length: 200 }, generateKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(KEY_RE);
  });

  it("stores only the SHA-256 hash, never the raw key", async () => {
    const env = await startEnv();
    try {
      const rows = env.db.prepare("SELECT * FROM api_keys").all() as Record<string, unknown>[];
      expect(rows.length).toBe(2);
      for (const row of rows) {
        const dump = JSON.stringify(row);
        expect(dump).not.toContain(env.keyA);
        expect(dump).not.toContain(env.keyB);
      }
      expect(rows.map((r) => r["key_hash"])).toContain(hashKey(env.keyA));
      expect(hashKey(env.keyA)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await env.close();
    }
  });

  it("allows at most 5 active keys per user, and revoking frees a slot", async () => {
    const env = await startEnv();
    try {
      const created = Array.from({ length: 3 }, (_, i) =>
        createApiKey(env.db, { tenantId: "cafe-arequipa", name: `k${i}`, userId: "ana" }),
      );
      createApiKey(env.db, { tenantId: "cafe-arequipa", name: "k3", userId: "ana" });
      createApiKey(env.db, { tenantId: "cafe-arequipa", name: "k4", userId: "ana" });
      expect(() => createApiKey(env.db, { tenantId: "cafe-arequipa", name: "k5", userId: "ana" })).toThrow(KeyLimitError);
      // another user is unaffected
      expect(() => createApiKey(env.db, { tenantId: "cafe-arequipa", name: "x", userId: "luis" })).not.toThrow();
      revokeApiKey(env.db, created[0]!.id);
      expect(() => createApiKey(env.db, { tenantId: "cafe-arequipa", name: "k5", userId: "ana" })).not.toThrow();
    } finally {
      await env.close();
    }
  });

  it("refuses to create a key for an unknown tenant", async () => {
    const env = await startEnv();
    try {
      expect(() => createApiKey(env.db, { tenantId: "nope", name: "x" })).toThrow(UnknownTenantError);
    } finally {
      await env.close();
    }
  });
});

describe("extractBearer", () => {
  it("parses well-formed headers only", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("bearer abc")).toBe("abc");
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("Bearer a b")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
  });
});

describe("authenticateKey", () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  it("accepts a valid key and resolves its tenant from the record", () => {
    const ctx = authenticateKey(env.db, env.keyA, new Date(NOW_MS));
    expect(ctx?.tenantId).toBe("cafe-arequipa");
    expect(ctx?.keyPrefix).toBe(env.keyA.slice(0, 8));
    expect(ctx?.keyHash).toBe(hashKey(env.keyA));
  });

  it("rejects malformed, unknown, revoked and expired keys", () => {
    const now = new Date(NOW_MS);
    expect(authenticateKey(env.db, null, now)).toBeNull();
    expect(authenticateKey(env.db, "zx_short", now)).toBeNull();
    expect(authenticateKey(env.db, generateKey(), now)).toBeNull();

    const revoked = createApiKey(env.db, { tenantId: "compu-lima", name: "r", userId: "u1" });
    expect(authenticateKey(env.db, revoked.key, now)).not.toBeNull();
    revokeApiKey(env.db, revoked.id, now);
    expect(authenticateKey(env.db, revoked.key, now)).toBeNull();

    const expiring = createApiKey(env.db, {
      tenantId: "compu-lima",
      name: "e",
      userId: "u2",
      now,
      expiresAt: new Date(NOW_MS + 1000),
    });
    expect(authenticateKey(env.db, expiring.key, now)).not.toBeNull();
    expect(authenticateKey(env.db, expiring.key, new Date(NOW_MS + 1000))).toBeNull();
  });
});

describe("HTTP authentication", () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  it("returns 401 + WWW-Authenticate: Bearer without a key", async () => {
    const r = await rpc(env, null, "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("returns 401 for malformed, invented, revoked and expired keys", async () => {
    const bad = [
      "garbage",
      generateKey(),
      (() => {
        const k = createApiKey(env.db, { tenantId: "compu-lima", name: "rev", userId: "u3" });
        revokeApiKey(env.db, k.id);
        return k.key;
      })(),
      createApiKey(env.db, {
        tenantId: "compu-lima",
        name: "exp",
        userId: "u4",
        now: new Date(NOW_MS - 10_000),
        expiresAt: new Date(NOW_MS - 1),
      }).key,
    ];
    for (const key of bad) {
      const r = await rpc(env, key, "tools/list");
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(JSON.stringify(r.body)).not.toContain(key);
    }
  });

  it("serves initialize and tools/list with a valid key", async () => {
    const init = await rpc(env, env.keyA, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("erp-mcp-server-demo");

    const list = await rpc(env, env.keyA, "tools/list");
    expect(list.status).toBe(200);
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "get_cash_register_status",
      "get_low_stock_products",
      "get_receivables_summary",
      "get_sales_summary",
      "get_top_products",
      "list_receivables",
      "search_products",
    ]);
  });

  it("exposes only read-only tools (no write verbs, readOnlyHint set)", async () => {
    const list = await rpc(env, env.keyA, "tools/list");
    for (const t of list.body.result.tools) {
      expect(t.name).toMatch(/^(get|list|search)_/);
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("does not support GET/DELETE on /mcp (stateless) and still requires auth", async () => {
    expect((await fetch(`${env.url}/mcp`)).status).toBe(401);
    const authed = await fetch(`${env.url}/mcp`, { headers: { authorization: `Bearer ${env.keyA}` } });
    expect(authed.status).toBe(405);
  });
});
