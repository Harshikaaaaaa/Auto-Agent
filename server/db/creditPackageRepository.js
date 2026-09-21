import crypto from 'crypto';
import { getPool } from './pool.js';

/** Top-up credit packages. Configurable rows (seeded in migration 007). */

function mapPackage(row) {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    pricePaise: Number(row.price_paise),
    credits: Number(row.credits),
    bonusCredits: Number(row.bonus_credits),
    enabled: Boolean(row.enabled),
    expiresDays: row.expires_days === null ? null : Number(row.expires_days),
    sortOrder: Number(row.sort_order),
  };
}

export async function listPackages({ includeDisabled = false } = {}) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  const [rows] = await getPool().query(
    `SELECT * FROM credit_packages ${where} ORDER BY sort_order, price_paise`,
  );
  return rows.map(mapPackage);
}

export async function getPackageById(id) {
  const [rows] = await getPool().query('SELECT * FROM credit_packages WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? mapPackage(rows[0]) : null;
}

export async function createPackage(input, { now = new Date() } = {}) {
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO credit_packages
       (id, code, display_name, price_paise, credits, bonus_credits, enabled, expires_days, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.code,
      input.displayName,
      Math.round(Number(input.pricePaise)),
      Math.round(Number(input.credits)),
      Math.round(Number(input.bonusCredits ?? 0)),
      input.enabled === false ? 0 : 1,
      input.expiresDays ?? null,
      input.sortOrder ?? 0,
      now,
      now,
    ],
  );
  return getPackageById(id);
}

export { mapPackage };
