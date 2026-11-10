import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiKey } from "../src/auth.js";
import { createApp, type AppOptions } from "../src/app.js";
import type { AuditEntry } from "../src/audit.js";
import { openDb, type Db } from "../src/db.js";
import { seedDatabase } from "../src/seed.js";

export const AS_OF = "2026-03-15";
/** 2026-03-15 12:00 in Lima (17:00 UTC). */
export const NOW_MS = Date.parse("2026-03-15T17:00:00Z");

export interface Env {
  db: Db;
  url: string;
  keyA: string; // cafe-arequipa
  keyB: string; // compu-lima
  audit: AuditEntry[];
  clock: { now: number };
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

export async function startEnv(overrides: Partial<AppOptions> = {}): Promise<Env> {
  const db = openDb(":memory:");
  seedDatabase(db, { asOf: AS_OF });
  const clock = { now: NOW_MS };
  const audit: AuditEntry[] = [];
  const app = createApp({ db, now: () => clock.now, audit: (e) => audit.push(e), ...overrides });
  const server: Server = await new Promise((resolve) => {
    const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    url: `http://127.0.0.1:${port}`,
    keyA: createApiKey(db, { tenantId: "cafe-arequipa", name: "test-a", now: new Date(NOW_MS) }).key,
    keyB: createApiKey(db, { tenantId: "compu-lima", name: "test-b", now: new Date(NOW_MS) }).key,
    audit,
    clock,
    app,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

export interface RpcResponse {
  status: number;
  headers: Headers;
  body: any;
}

export async function rpc(
  env: Env,
  key: string | null,
  method: string,
  params?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<RpcResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (key) headers["authorization"] = `Bearer ${key}`;
  const res = await fetch(`${env.url}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

export async function callTool(
  env: Env,
  key: string,
  name: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
) {
  const r = await rpc(env, key, "tools/call", { name, arguments: args }, extraHeaders);
  const result = r.body?.result;
  const text: string = result?.content?.[0]?.text ?? "";
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { http: r.status, isError: result?.isError === true, text, data, raw: r.body };
}
