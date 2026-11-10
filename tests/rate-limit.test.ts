import { describe, expect, it } from "vitest";
import { authenticateKey, generateKey, hashKey } from "../src/auth.js";
import { RateLimiter } from "../src/rate-limit.js";
import { rpc, startEnv } from "./helpers.js";

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks until the window resets", () => {
    let t = 1_000_000;
    const rl = new RateLimiter(3, 60_000, () => t);
    expect([1, 2, 3].map(() => rl.hit("a").allowed)).toEqual([true, true, true]);
    const blocked = rl.hit("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
    expect(rl.hit("b").allowed).toBe(true); // other buckets unaffected
    t += 30_000;
    expect(rl.hit("a").retryAfterSec).toBe(30);
    t += 30_000;
    expect(rl.hit("a").allowed).toBe(true);
  });

  it("sweeps expired buckets so memory does not grow forever", () => {
    let t = 0;
    const rl = new RateLimiter(5, 1_000, () => t);
    for (let i = 0; i < 100; i++) rl.hit(`ip-${i}`);
    expect(rl.bucketIds().length).toBe(100);
    t += 5_000;
    rl.hit("fresh");
    expect(rl.bucketIds()).toEqual(["fresh"]);
  });
});

describe("HTTP rate limits", () => {
  it("per-IP limit (120/min) triggers BEFORE key validation: invented keys can't hammer storage", async () => {
    let lookups = 0;
    const env = await startEnv({
      authenticate: (db, raw, now) => {
        lookups += 1;
        return authenticateKey(db, raw, now);
      },
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 125; i++) statuses.push((await rpc(env, generateKey(), "tools/list")).status);
      expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(120)).toEqual([429, 429, 429, 429, 429]);
      expect(lookups).toBe(120); // the 5 throttled requests never reached the key store
      const last = await rpc(env, generateKey(), "tools/list");
      expect(last.status).toBe(429);
      expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      // a valid key from the same IP is throttled too: the IP check comes first
      expect((await rpc(env, env.keyA, "tools/list")).status).toBe(429);
    } finally {
      await env.close();
    }
  });

  it("per-key limit (60/min) returns 429 + Retry-After and is independent per key", async () => {
    const env = await startEnv();
    try {
      for (let i = 0; i < 60; i++) expect((await rpc(env, env.keyA, "tools/list")).status).toBe(200);
      const blocked = await rpc(env, env.keyA, "tools/list");
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      // key B (same IP, still under the IP limit) keeps working
      expect((await rpc(env, env.keyB, "tools/list")).status).toBe(200);
    } finally {
      await env.close();
    }
  });

  it("the window resets after a minute", async () => {
    const env = await startEnv();
    try {
      for (let i = 0; i < 61; i++) await rpc(env, env.keyA, "tools/list");
      expect((await rpc(env, env.keyA, "tools/list")).status).toBe(429);
      env.clock.now += 61_000;
      expect((await rpc(env, env.keyA, "tools/list")).status).toBe(200);
    } finally {
      await env.close();
    }
  });

  it("buckets are keyed by hash: the raw key never appears in limiter state", async () => {
    const env = await startEnv();
    try {
      await rpc(env, env.keyA, "tools/list");
      const ids = env.app.keyLimiter.bucketIds();
      expect(ids).toEqual([hashKey(env.keyA)]);
      expect(ids.join()).not.toContain(env.keyA);
    } finally {
      await env.close();
    }
  });
});
