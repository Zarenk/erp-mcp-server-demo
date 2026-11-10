import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateKey, extractBearer, type AuthContext } from "./auth.js";
import { stderrAudit, type AuditSink } from "./audit.js";
import type { Db } from "./db.js";
import { createMcpServer } from "./mcp.js";
import { RateLimiter } from "./rate-limit.js";

export const IP_LIMIT_PER_MIN = 120;
export const KEY_LIMIT_PER_MIN = 60;

export interface AppOptions {
  db: Db;
  audit?: AuditSink;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  ipLimit?: number;
  keyLimit?: number;
  /** Express "trust proxy" setting; only enable behind a proxy you control. */
  trustProxy?: boolean | number | string;
  /** Test seam: lets tests observe whether key storage was consulted. */
  authenticate?: typeof authenticateKey;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp(opts: AppOptions) {
  const now = opts.now ?? Date.now;
  const audit = opts.audit ?? stderrAudit;
  const authenticate = opts.authenticate ?? authenticateKey;
  const ipLimiter = new RateLimiter(opts.ipLimit ?? IP_LIMIT_PER_MIN, 60_000, now);
  const keyLimiter = new RateLimiter(opts.keyLimit ?? KEY_LIMIT_PER_MIN, 60_000, now);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", opts.trustProxy ?? false);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  function reject429(res: Response, retryAfterSec: number): void {
    res.set("Retry-After", String(retryAfterSec));
    jsonRpcError(res, 429, -32029, "Rate limit exceeded");
  }

  // 1) Per-IP limit FIRST: invented keys must not be able to hammer the key store.
  const ipGuard = (req: Request, res: Response, next: NextFunction) => {
    const r = ipLimiter.hit(req.ip ?? "unknown");
    if (!r.allowed) return reject429(res, r.retryAfterSec);
    next();
  };

  // 2) API key authentication. Failure reasons are never distinguished to the client.
  const keyAuth = (req: Request, res: Response, next: NextFunction) => {
    const ctx = authenticate(opts.db, extractBearer(req.header("authorization")), new Date(now()));
    if (!ctx) {
      res.set("WWW-Authenticate", 'Bearer realm="erp-mcp-demo"');
      return jsonRpcError(res, 401, -32001, "Unauthorized");
    }
    res.locals["auth"] = ctx;
    next();
  };

  // 3) Per-key limit, bucketed by the key HASH (the raw key never enters this map).
  const keyGuard = (_req: Request, res: Response, next: NextFunction) => {
    const r = keyLimiter.hit((res.locals["auth"] as AuthContext).keyHash);
    if (!r.allowed) return reject429(res, r.retryAfterSec);
    next();
  };

  const guards = [ipGuard, keyAuth, keyGuard];

  // Body is parsed only AFTER authentication, so anonymous callers can't make us parse payloads.
  app.post("/mcp", ...guards, express.json({ limit: "100kb" }), async (req, res) => {
    const auth = res.locals["auth"] as AuthContext;
    // NOTE: x-org-id / x-company-id style headers are deliberately never read anywhere.
    const server = createMcpServer({ db: opts.db, auth, audit, now });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  // Stateless server: no SSE stream, no sessions to delete.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", ...guards, (_req, res) => {
      res.set("Allow", "POST");
      jsonRpcError(res, 405, -32000, "Method not allowed");
    });
  }

  // Malformed JSON etc.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    jsonRpcError(res, 400, -32700, "Parse error");
  });

  return { app, ipLimiter, keyLimiter };
}
