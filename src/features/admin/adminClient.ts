import { apiUrl } from '@config/api';
import type {
  ActiveSubscription,
  CreditPackage,
  CreditTransaction,
  PaymentRow,
  Plan,
  UsageRow,
  WalletBalance,
} from '@features/billing/billingClient';

/**
 * Client for the /api/admin endpoints. The whole prefix is gated server-side by
 * requireAdmin, so a non-admin session gets a 403 here regardless of the UI.
 *
 * As with the billing client, money is only ever read as integers (credits,
 * paise) — nothing is computed on this side.
 */

export interface AdminUser {
  id: string;
  ownerId: string;
  email: string;
  role: 'user' | 'admin';
  status: string;
  emailVerified: boolean;
  createdAt: string | null;
}

export interface AdminUserDetail {
  user: AdminUser;
  wallet: WalletBalance | null;
  subscription: ActiveSubscription | null;
  transactions: CreditTransaction[];
  payments: PaymentRow[];
  usage: UsageRow[];
}

export interface RateRow {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  input_price_per_1m_micros: number;
  cached_input_price_per_1m_micros: number;
  output_price_per_1m_micros: number;
  reasoning_price_per_1m_micros: number;
  provider_fee_bps: number;
  markup_multiplier_x10: number;
  billing_exchange_rate_paise_usd: number;
  minimum_credit_charge: number;
  maximum_output_tokens: number | null;
  enabled: boolean;
  freePlanAllowed: boolean;
  starterPlanAllowed: boolean;
  proPlanAllowed: boolean;
  businessPlanAllowed: boolean;
}

export interface Coupon {
  id: string;
  code: string;
  couponType: string;
  percentBps: number | null;
  fixedDiscountPaise: number | null;
  bonusCredits?: number | null;
  appliesTo?: string;
  perUserLimit?: number;
  maxRedemptions: number | null;
  timesRedeemed?: number;
  redeemedCount?: number;
  enabled: boolean;
}

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { credentials: 'same-origin' });
  } catch {
    throw new AdminError('Could not reach the server.', 0, 'network_error');
  }
  if (res.status === 403) {
    throw new AdminError('Admin access required.', 403, 'forbidden');
  }
  if (!res.ok) {
    throw new AdminError(`Request failed (${res.status}).`, res.status, 'request_failed');
  }
  return (await res.json()) as T;
}

async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    let code = 'request_failed';
    try {
      const parsed = (await res.json()) as { message?: string; error?: string };
      if (parsed.message) message = parsed.message;
      if (parsed.error) code = parsed.error;
    } catch {
      // non-JSON body
    }
    throw new AdminError(message, res.status, code);
  }
  return (await res.json()) as T;
}

export function fetchUsers(search?: string) {
  const q = search ? `?q=${encodeURIComponent(search)}` : '';
  return getJson<{ users: AdminUser[] }>(`/api/admin/users${q}`).then((r) => r.users);
}

export function fetchUserDetail(ownerId: string) {
  return getJson<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(ownerId)}`);
}

export function adjustCredits(input: {
  ownerId: string;
  amount: number;
  reason: string;
  bucket?: 'subscription' | 'bonus' | 'purchased';
}) {
  const { ownerId, ...body } = input;
  return send<{ wallet: WalletBalance }>(
    'POST',
    `/api/admin/users/${encodeURIComponent(ownerId)}/adjust`,
    body,
  ).then((r) => r.wallet);
}

export function fetchAdminPlans() {
  return getJson<{ plans: Plan[] }>('/api/admin/plans').then((r) => r.plans);
}

export function fetchAdminPackages() {
  return getJson<{ packages: CreditPackage[] }>('/api/admin/packages').then((r) => r.packages);
}

export function fetchRates() {
  return getJson<{ rates: RateRow[] }>('/api/admin/rates').then((r) => r.rates);
}

export function updateRate(id: string, fields: Partial<RateRow>) {
  return send<{ rate: RateRow }>('PUT', `/api/admin/rates/${encodeURIComponent(id)}`, fields).then(
    (r) => r.rate,
  );
}

export function fetchCoupons() {
  return getJson<{ coupons: Coupon[] }>('/api/admin/coupons').then((r) => r.coupons);
}

export interface SettingStatus {
  key: string;
  kind: 'secret' | 'text' | 'bool' | 'enum';
  source: 'db' | 'env' | 'unset';
  managedInDb: boolean;
  configured: boolean;
  masked?: string | null;
  value?: string | boolean | null;
  options?: string[];
}

export function fetchSettings() {
  return getJson<{ settings: SettingStatus[] }>('/api/admin/settings').then((r) => r.settings);
}

export function updateSettings(patch: Record<string, string | boolean | null>) {
  return send<{ updated: string[]; settings: SettingStatus[] }>(
    'PUT',
    '/api/admin/settings',
    patch,
  );
}

// ---------------------------------------------------------------- dashboard

export interface DashboardMetrics {
  users: number;
  suspendedUsers: number;
  activeSubscriptions: number;
  mrrPaise: number;
  creditsOutstanding: number;
  creditsUsedThisMonth: number;
  revenueThisMonthPaise: number;
  revenueTotalPaise: number;
}

export interface RecentPayment {
  id: string;
  ownerId: string;
  email: string | null;
  type: string;
  amountPaise: number;
  status: string;
  createdAt: string | null;
}

export function fetchDashboard() {
  return getJson<{ metrics: DashboardMetrics; recentPayments: RecentPayment[] }>(
    '/api/admin/dashboard',
  );
}

// ------------------------------------------------------------- user actions

export function setUserRole(ownerId: string, role: 'user' | 'admin') {
  return send<{ user: AdminUser }>('PUT', `/api/admin/users/${encodeURIComponent(ownerId)}/role`, {
    role,
  }).then((r) => r.user);
}

export function setUserStatus(ownerId: string, status: 'active' | 'suspended') {
  return send<{ user: AdminUser }>(
    'PUT',
    `/api/admin/users/${encodeURIComponent(ownerId)}/status`,
    { status },
  ).then((r) => r.user);
}

export function assignUserPlan(ownerId: string, planId: string) {
  return send<{ subscription: ActiveSubscription | null; wallet: WalletBalance }>(
    'PUT',
    `/api/admin/users/${encodeURIComponent(ownerId)}/plan`,
    { planId },
  );
}

// ------------------------------------------------------------------- plans

export interface AdminPlan {
  id: string;
  code: string;
  displayName: string;
  pricePaise: number;
  billingCycle: string;
  includedCredits: number;
  enabled: boolean;
  sortOrder: number;
}

export function createPlan(input: {
  code: string;
  displayName: string;
  pricePaise: number;
  includedCredits: number;
  billingCycle?: string;
  sortOrder?: number;
}) {
  return send<{ plan: AdminPlan }>('POST', '/api/admin/plans', input).then((r) => r.plan);
}

export function updatePlan(
  id: string,
  fields: Partial<Omit<AdminPlan, 'id' | 'code'>> & { enabled?: boolean },
) {
  return send<{ plan: AdminPlan }>(
    'PUT',
    `/api/admin/plans/${encodeURIComponent(id)}`,
    fields,
  ).then((r) => r.plan);
}

// ---------------------------------------------------------------- packages

export interface AdminPackage {
  id: string;
  code: string;
  displayName: string;
  pricePaise: number;
  credits: number;
  bonusCredits: number;
  enabled: boolean;
  sortOrder: number;
}

export function createPackage(input: {
  code: string;
  displayName: string;
  pricePaise: number;
  credits: number;
  bonusCredits?: number;
  sortOrder?: number;
}) {
  return send<{ package: AdminPackage }>('POST', '/api/admin/packages', input).then(
    (r) => r.package,
  );
}

export function updatePackage(
  id: string,
  fields: Partial<Omit<AdminPackage, 'id' | 'code'>> & { enabled?: boolean },
) {
  return send<{ package: AdminPackage }>(
    'PUT',
    `/api/admin/packages/${encodeURIComponent(id)}`,
    fields,
  ).then((r) => r.package);
}

// ----------------------------------------------------------------- coupons

export function createRate(input: Partial<RateRow> & { provider: string; modelId: string }) {
  return send<{ rate: RateRow }>('POST', '/api/admin/rates', input).then((r) => r.rate);
}

export function createCoupon(input: {
  code: string;
  couponType: 'percentage' | 'fixed' | 'bonus_credits';
  percentBps?: number | null;
  fixedDiscountPaise?: number | null;
  bonusCredits?: number | null;
  appliesTo?: string;
  maxRedemptions?: number | null;
  perUserLimit?: number;
}) {
  return send<{ coupon: Coupon }>('POST', '/api/admin/coupons', input).then((r) => r.coupon);
}

export function updateCoupon(id: string, fields: { enabled?: boolean; maxRedemptions?: number }) {
  return send<{ coupon: Coupon }>(
    'PUT',
    `/api/admin/coupons/${encodeURIComponent(id)}`,
    fields,
  ).then((r) => r.coupon);
}

// ------------------------------------------------------------ settings test

export interface AiProbe {
  ok: boolean;
  provider: string;
  model: string;
  detail: string;
}

export function testAiConnection() {
  return getJson<{ probe: AiProbe }>('/api/admin/settings/test-ai').then((r) => r.probe);
}
