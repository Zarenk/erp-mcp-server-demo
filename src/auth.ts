import { createHash, randomInt } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Personal API keys: `zx_` + 40 base62 chars (~238 bits of entropy).
 * Only the SHA-256 hash is stored. The raw key is shown once, at creation.
 * A fast hash is fine here (not a password): the key is already high-entropy random.
 */
export const KEY_RE = /^zx_[0-9A-Za-z]{40}$/;
export const MAX_ACTIVE_KEYS_PER_USER = 5;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateKey(): string {
  let body = "";
  for (let i = 0; i < 40; i++) body += BASE62[randomInt(62)];
  return `zx_${body}`;
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/** Short, non-secret identifier for logs: `zx_` + first 5 chars. Not enough to use the key. */
export function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, 8);
}

export class KeyLimitError extends Error {}
export class UnknownTenantError extends Error {}

export interface CreateKeyInput {
  tenantId: string;
  name: string;
  userId?: string;
  expiresAt?: Date;
  now?: Date;
}

export function createApiKey(db: Db, input: CreateKeyInput): { key: string; id: number; prefix: string } {
  const now = input.now ?? new Date();
  const userId = input.userId ?? `owner@${input.tenantId}`;
  const tenant = db.prepare("SELECT id FROM tenants WHERE id = ?").get(input.tenantId);
  if (!tenant) throw new UnknownTenantError(`unknown tenant "${input.tenantId}"`);

  const create = db.transaction(() => {
    const active = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM api_keys
           WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(userId, now.toISOString()) as { n: number }
    ).n;
    if (active >= MAX_ACTIVE_KEYS_PER_USER) {
      throw new KeyLimitError(`user already has ${MAX_ACTIVE_KEYS_PER_USER} active keys; revoke one first`);
    }
    const key = generateKey();
    const r = db
      .prepare(
        `INSERT INTO api_keys (tenant_id,user_id,name,prefix,key_hash,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        input.tenantId,
        userId,
        input.name,
        keyPrefix(key),
        hashKey(key),
        now.toISOString(),
        input.expiresAt ? input.expiresAt.toISOString() : null,
      );
    return { key, id: Number(r.lastInsertRowid), prefix: keyPrefix(key) };
  });
  return create();
}

export function revokeApiKey(db: Db, id: number, now: Date = new Date()): void {
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), id);
}

export interface AuthContext {
  keyId: number;
  /** SHA-256 of the key. Used as the rate-limit bucket id, so the raw key is never held in memory maps. */
  keyHash: string;
  keyPrefix: string;
  /** The ONLY source of tenant identity in the whole system. */
  tenantId: string;
}

export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/** Returns null for any failure (malformed, unknown, revoked, expired): callers can't tell which. */
export function authenticateKey(db: Db, rawKey: string | null, now: Date = new Date()): AuthContext | null {
  if (!rawKey || !KEY_RE.test(rawKey)) return null;
  const keyHash = hashKey(rawKey);
  const row = db
    .prepare(
      `SELECT id, tenant_id AS tenantId, prefix, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM api_keys WHERE key_hash = ?`,
    )
    .get(keyHash) as
    | { id: number; tenantId: string; prefix: string; expiresAt: string | null; revokedAt: string | null }
    | undefined;
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt <= now.toISOString()) return null;
  return { keyId: row.id, keyHash, keyPrefix: row.prefix, tenantId: row.tenantId };
}
