import fs from "node:fs";
import { parseArgs } from "node:util";
import { KeyLimitError, UnknownTenantError, createApiKey } from "../auth.js";
import { DB_PATH } from "../config.js";
import { openDb } from "../db.js";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    name: { type: "string" },
    user: { type: "string" },
    "expires-days": { type: "string" },
  },
});

if (!values.tenant || !values.name) {
  console.error("Usage: npm run keys:create -- --tenant <id> --name <label> [--user <id>] [--expires-days <n>]");
  process.exit(2);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run: npm run seed`);
  process.exit(1);
}

let expiresAt: Date | undefined;
if (values["expires-days"] !== undefined) {
  const days = Number(values["expires-days"]);
  if (!Number.isInteger(days) || days < 1) {
    console.error("--expires-days must be a positive integer");
    process.exit(2);
  }
  expiresAt = new Date(Date.now() + days * 86_400_000);
}

const db = openDb(DB_PATH);
try {
  const { key, prefix } = createApiKey(db, {
    tenantId: values.tenant,
    name: values.name,
    ...(values.user ? { userId: values.user } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  });
  console.log(`API key created for tenant "${values.tenant}" (prefix ${prefix}).`);
  console.log("Copy it now. Only its SHA-256 hash is stored, so it cannot be shown again:\n");
  console.log(key);
} catch (e) {
  if (e instanceof KeyLimitError || e instanceof UnknownTenantError) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  throw e;
} finally {
  db.close();
}
