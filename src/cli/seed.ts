import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "../config.js";
import { limaDate } from "../dates.js";
import { openDb } from "../db.js";
import { SEED_TENANT_IDS, seedDatabase } from "../seed.js";

// Re-seeding wipes the demo database (keys included): it only ever holds fake data.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

const db = openDb(DB_PATH);
const asOf = limaDate(Date.now());
seedDatabase(db, { asOf });
db.close();

console.log(`Seeded ${DB_PATH} with ${SEED_TENANT_IDS.length} fake tenants (sales through ${asOf}).`);
console.log(`Tenants: ${SEED_TENANT_IDS.join(", ")}`);
console.log("Next: npm run keys:create -- --tenant <id> --name <name>");
