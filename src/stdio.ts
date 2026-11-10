import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authenticateKey } from "./auth.js";
import { stderrAudit } from "./audit.js";
import { DB_PATH } from "./config.js";
import { openDb } from "./db.js";
import { createMcpServer } from "./mcp.js";

// stdout carries the protocol, so every log line goes to stderr.
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run: npm run seed`);
  process.exit(1);
}

const db = openDb(DB_PATH);
const auth = authenticateKey(db, process.env["ERP_API_KEY"] ?? null);
if (!auth) {
  console.error("ERP_API_KEY is missing, malformed, revoked or expired.");
  process.exit(1);
}

const server = createMcpServer({ db, auth, audit: stderrAudit, now: Date.now });
await server.connect(new StdioServerTransport());
