import path from "node:path";

export const DB_PATH = process.env["ERP_DB_PATH"] ?? path.resolve("data", "erp.db");
export const PORT = Number(process.env["PORT"] ?? 3333);
