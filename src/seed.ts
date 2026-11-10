import type { Db } from "./db.js";
import { addDays } from "./dates.js";

/** Small deterministic PRNG so the demo data (and the tests) are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ProductSeed {
  sku: string;
  name: string;
  price: number; // cents, IGV included
  stock: number;
}

interface TenantSeed {
  id: string;
  name: string;
  city: string;
  currency: "PEN" | "USD";
  products: ProductSeed[];
  salesPerDay: [number, number];
  payments: string[];
  openingCents: number;
  movements: { kind: "in" | "out"; cents: number; note: string }[];
  receivables: { customer: string; document: string; cents: number; paid: number; dueOffsetDays: number }[];
}

const TENANTS: TenantSeed[] = [
  {
    id: "cafe-arequipa",
    name: "Cafe Misti (demo)",
    city: "Arequipa",
    currency: "PEN",
    salesPerDay: [14, 28],
    payments: ["cash", "card", "yape", "cash"],
    openingCents: 20_000,
    movements: [
      { kind: "out", cents: 3_500, note: "Ice and napkins" },
      { kind: "out", cents: 12_000, note: "Milk supplier (cash on delivery)" },
      { kind: "in", cents: 5_000, note: "Change from owner" },
    ],
    products: [
      { sku: "CAF-001", name: "Espresso", price: 700, stock: 999 },
      { sku: "CAF-002", name: "Americano", price: 800, stock: 999 },
      { sku: "CAF-003", name: "Cappuccino", price: 1_200, stock: 999 },
      { sku: "CAF-004", name: "Latte", price: 1_300, stock: 999 },
      { sku: "CAF-005", name: "Chai tea", price: 1_000, stock: 40 },
      { sku: "CAF-006", name: "Butter croissant", price: 900, stock: 4 },
      { sku: "CAF-007", name: "Pork sandwich (chicharron)", price: 1_800, stock: 22 },
      { sku: "CAF-008", name: "Chocolate cake slice", price: 1_400, stock: 12 },
      { sku: "CAF-009", name: "Arequipa beans 250g", price: 3_200, stock: 18 },
      { sku: "CAF-010", name: "Arequipa beans 1kg", price: 11_000, stock: 3 },
      { sku: "CAF-011", name: "Orange juice", price: 1_100, stock: 30 },
      { sku: "CAF-012", name: "Alfajor", price: 450, stock: 35 },
      { sku: "CAF-013", name: "Bottled water", price: 300, stock: 2 },
      { sku: "CAF-014", name: "Quinoa cookie", price: 500, stock: 26 },
    ],
    receivables: [
      { customer: "Andes Mining Services (demo)", document: "F001-00041", cents: 85_000, paid: 0, dueOffsetDays: -21 },
      { customer: "Hotel Plaza Blanca (demo)", document: "F001-00047", cents: 42_000, paid: 12_000, dueOffsetDays: -6 },
      { customer: "Colegio Santa Rosa (demo)", document: "F001-00052", cents: 28_500, paid: 0, dueOffsetDays: 9 },
      { customer: "Notaria Delgado (demo)", document: "F001-00055", cents: 15_000, paid: 0, dueOffsetDays: 20 },
    ],
  },
  {
    id: "compu-lima",
    name: "CompuNorte Lima (demo)",
    city: "Lima",
    currency: "USD",
    salesPerDay: [2, 7],
    payments: ["card", "transfer", "cash", "card"],
    openingCents: 15_000,
    movements: [
      { kind: "out", cents: 4_000, note: "Courier delivery" },
      { kind: "in", cents: 20_000, note: "Cash sale deposit" },
    ],
    products: [
      { sku: "PC-001", name: 'Laptop 15.6" i5 16GB', price: 78_900, stock: 9 },
      { sku: "PC-002", name: 'Laptop 14" Ryzen 5 8GB', price: 59_900, stock: 6 },
      { sku: "PC-003", name: "Wireless mouse", price: 1_500, stock: 48 },
      { sku: "PC-004", name: "Mechanical keyboard", price: 4_900, stock: 15 },
      { sku: "PC-005", name: 'Monitor 24" IPS', price: 14_900, stock: 11 },
      { sku: "PC-006", name: "SSD 1TB NVMe", price: 8_500, stock: 2 },
      { sku: "PC-007", name: "RAM 16GB DDR4", price: 4_500, stock: 3 },
      { sku: "PC-008", name: "HDMI cable 2m", price: 900, stock: 60 },
      { sku: "PC-009", name: "WiFi 6 router", price: 6_900, stock: 14 },
      { sku: "PC-010", name: "Inkjet printer", price: 12_900, stock: 5 },
      { sku: "PC-011", name: "Webcam 1080p", price: 3_900, stock: 1 },
      { sku: "PC-012", name: "USB flash drive 64GB", price: 800, stock: 80 },
    ],
    receivables: [
      { customer: "Estudio Contable Rivas (demo)", document: "F001-00210", cents: 189_000, paid: 0, dueOffsetDays: -45 },
      { customer: "Taller Mecanico Sol (demo)", document: "F001-00214", cents: 59_800, paid: 20_000, dueOffsetDays: -30 },
      { customer: "Clinica Dental Sonrisa (demo)", document: "F001-00219", cents: 74_900, paid: 0, dueOffsetDays: -12 },
      { customer: "Agencia Viajes Costa (demo)", document: "F001-00223", cents: 31_500, paid: 0, dueOffsetDays: -3 },
      { customer: "Libreria Central (demo)", document: "F001-00226", cents: 22_000, paid: 0, dueOffsetDays: -1 },
      { customer: "Instituto Tecnico Norte (demo)", document: "F001-00230", cents: 236_000, paid: 100_000, dueOffsetDays: 14 },
      { customer: "Bodega Don Pepe (demo)", document: "F001-00233", cents: 9_900, paid: 0, dueOffsetDays: 25 },
      { customer: "Consultora Pacifico (demo)", document: "F001-00238", cents: 45_000, paid: 0, dueOffsetDays: 30 },
    ],
  },
];

export const SEED_TENANT_IDS = TENANTS.map((t) => t.id);

export interface SeedOptions {
  /** Last day of sales history (YYYY-MM-DD). */
  asOf: string;
  days?: number;
  seed?: number;
}

/** Fills an empty database with FAKE data for two fictional tenants. */
export function seedDatabase(db: Db, opts: SeedOptions): void {
  const days = opts.days ?? 60;
  const rand = mulberry32(opts.seed ?? 42);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  const insTenant = db.prepare("INSERT INTO tenants (id,name,city,currency) VALUES (?,?,?,?)");
  const insProduct = db.prepare(
    "INSERT INTO products (tenant_id,sku,name,price_cents,stock) VALUES (?,?,?,?,?)",
  );
  const insSale = db.prepare(
    "INSERT INTO sales (tenant_id,sale_date,total_cents,payment_method) VALUES (?,?,?,?)",
  );
  const insItem = db.prepare(
    "INSERT INTO sale_items (sale_id,product_id,quantity,unit_price_cents) VALUES (?,?,?,?)",
  );
  const insRecv = db.prepare(
    "INSERT INTO receivables (tenant_id,customer,document,amount_cents,paid_cents,due_date) VALUES (?,?,?,?,?,?)",
  );
  const insRegister = db.prepare(
    "INSERT INTO cash_registers (tenant_id,status,opened_on,opening_cents) VALUES (?,?,?,?)",
  );
  const insMove = db.prepare(
    "INSERT INTO cash_movements (tenant_id,move_date,kind,amount_cents,note) VALUES (?,?,?,?,?)",
  );

  db.transaction(() => {
    for (const t of TENANTS) {
      insTenant.run(t.id, t.name, t.city, t.currency);
      const productIds: { id: number; price: number }[] = [];
      for (const p of t.products) {
        const r = insProduct.run(t.id, p.sku, p.name, p.price, p.stock);
        productIds.push({ id: Number(r.lastInsertRowid), price: p.price });
      }
      for (let d = days - 1; d >= 0; d--) {
        const date = addDays(opts.asOf, -d);
        const n = between(t.salesPerDay[0], t.salesPerDay[1]);
        for (let i = 0; i < n; i++) {
          const lines = Array.from({ length: between(1, 3) }, () => {
            const prod = pick(productIds);
            return { prod, qty: t.currency === "USD" ? 1 : between(1, 2) };
          });
          const total = lines.reduce((s, l) => s + l.qty * l.prod.price, 0);
          const sale = insSale.run(t.id, date, total, pick(t.payments));
          for (const l of lines) insItem.run(Number(sale.lastInsertRowid), l.prod.id, l.qty, l.prod.price);
        }
      }
      for (const r of t.receivables) {
        insRecv.run(t.id, r.customer, r.document, r.cents, r.paid, addDays(opts.asOf, r.dueOffsetDays));
      }
      insRegister.run(t.id, "open", opts.asOf, t.openingCents);
      for (const m of t.movements) insMove.run(t.id, opts.asOf, m.kind, m.cents, m.note);
    }
  })();
}
