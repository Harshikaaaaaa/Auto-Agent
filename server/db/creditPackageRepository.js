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

/** Update the mutable fields of a package (admin console). */
export async function updatePackage(id, fields, { now = new Date() } = {}) {
  const columns = {
    displayName: 'display_name',
    pricePaise: 'price_paise',
    credits: 'credits',
    bonusCredits: 'bonus_credits',
    enabled: 'enabled',
    expiresDays: 'expires_days',
    sortOrder: 'sort_order',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(columns)) {
    if (fields[key] === undefined) continue;
    let value = fields[key];
    if (['pricePaise', 'credits', 'bonusCredits', 'sortOrder'].includes(key)) {
      value = Math.round(Number(value));
    }
    if (key === 'expiresDays') value = value === null ? null : Math.round(Number(value));
    if (key === 'enabled') value = value ? 1 : 0;
    sets.push(`${col} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return getPackageById(id);
  sets.push('updated_at = ?');
  params.push(now, id);
  await getPool().query(`UPDATE credit_packages SET ${sets.join(', ')} WHERE id = ?`, params);
  return getPackageById(id);
}

export { mapPackage };
