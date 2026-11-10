import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { DB_PATH, PORT } from "./config.js";
import { openDb } from "./db.js";

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run: npm run seed`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const trustProxy = process.env["TRUST_PROXY"] ? Number(process.env["TRUST_PROXY"]) : false;
const { app } = createApp({ db: openDb(DB_PATH), trustProxy });

// Bind to loopback only: this is a demo, not something to expose to a network as-is.
app.listen(PORT, "127.0.0.1", () => {
  console.error(`erp-mcp-server-demo listening on http://127.0.0.1:${PORT}/mcp`);
});
