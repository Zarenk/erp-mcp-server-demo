import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  city      TEXT NOT NULL,
  currency  TEXT NOT NULL CHECK (currency IN ('PEN','USD'))
);
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  sku         TEXT NOT NULL,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  sale_date      TEXT NOT NULL,
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  payment_method TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_date ON sales(tenant_id, sale_date);
CREATE TABLE IF NOT EXISTS sale_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id          INTEGER NOT NULL REFERENCES sales(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE TABLE IF NOT EXISTS receivables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  customer     TEXT NOT NULL,
  document     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_cents   INTEGER NOT NULL DEFAULT 0,
  due_date     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cash_registers (
  tenant_id     TEXT PRIMARY KEY REFERENCES tenants(id),
  status        TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_on     TEXT NOT NULL,
  opening_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cash_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  move_date    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('in','out')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  note         TEXT NOT NULL
);
`;

/** Opens (or creates) a SQLite database and applies the schema. Use ":memory:" in tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
