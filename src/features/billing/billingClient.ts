import { apiUrl } from '@config/api';

/**
 * Client for the /api/billing endpoints. The session rides in the httpOnly
 * cookie, so every call is credentialed and scoped server-side to the caller.
 *
 * Money never crosses this boundary as a float: credits and paise are integers
 * from the server, and this module only reads them.
 */

export interface WalletBalance {
  subscriptionCredits: number;
  bonusCredits: number;
  purchasedCredits: number;
  totalCredits: number;
  usedThisMonth: number;
  lifetimeUsed: number;
}

export interface ActiveSubscription {
  id: string;
  planCode: string;
  planName: string;
  status: string;
  billingCycle: string;
  pricePaise: number;
  includedCredits: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Plan {
  id: string;
  code: string;
  displayName: string;
  pricePaise: number;
  billingCycle: string;
  includedCredits: number;
  features: string[] | null;
}

export interface CreditPackage {
  id: string;
  code: string;
  displayName: string;
  pricePaise: number;
  credits: number;
  bonusCredits: number;
}

export interface CreditTransaction {
  id: string;
  type: string;
  credits: number;
  balanceAfter: number;
  provider: string | null;
  model: string | null;
  description: string | null;
  createdAt: string | null;
}

export interface UsageRow {
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  creditsCharged: number;
  status: string;
  createdAt: string | null;
}

export interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  byProvider: Array<{ provider: string; credits: number; requests: number }>;
  byModel: Array<{ model: string; credits: number; requests: number }>;
}

export interface PaymentRow {
  id: string;
  type: string;
  amountPaise: number;
  currency: string;
  creditsPurchased: number | null;
  status: string;
  createdAt: string | null;
  paidAt: string | null;
}

export class BillingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { credentials: 'same-origin' });
  } catch {
    throw new BillingError('Could not reach the server.', 0, 'network_error');
  }
  if (!res.ok) {
    throw new BillingError(`Request failed (${res.status}).`, res.status, 'request_failed');
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
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
    throw new BillingError(message, res.status, code);
  }
  return (await res.json()) as T;
}

export function fetchBalance() {
  return getJson<{ balance: WalletBalance; subscription: ActiveSubscription | null }>(
    '/api/billing/balance',
  );
}

export function fetchPlans() {
  return getJson<{ plans: Plan[] }>('/api/billing/plans').then((r) => r.plans);
}

export function fetchPackages() {
  return getJson<{ packages: CreditPackage[] }>('/api/billing/packages').then((r) => r.packages);
}

export function fetchTransactions(limit = 100) {
  return getJson<{ transactions: CreditTransaction[] }>(
    `/api/billing/transactions?limit=${limit}`,
  ).then((r) => r.transactions);
}

export function fetchUsage(limit = 100) {
  return getJson<{ usage: UsageRow[] }>(`/api/billing/usage?limit=${limit}`).then((r) => r.usage);
}

export function fetchUsageSummary(range: string) {
  return getJson<{ summary: UsageSummary; range: string }>(
    `/api/billing/usage/summary?range=${encodeURIComponent(range)}`,
  ).then((r) => r.summary);
}

export function fetchPayments(limit = 100) {
  return getJson<{ payments: PaymentRow[] }>(`/api/billing/payments?limit=${limit}`).then(
    (r) => r.payments,
  );
}

export interface GatewayOrder {
  orderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
}

export function createTopupOrder(packageId: string, couponCode?: string) {
  return postJson<{ order: GatewayOrder }>('/api/billing/topup/order', {
    packageId,
    couponCode,
  }).then((r) => r.order);
}

export function createSubscribeOrder(planId: string, couponCode?: string) {
  return postJson<{ order: GatewayOrder }>('/api/billing/subscribe/order', {
    planId,
    couponCode,
  }).then((r) => r.order);
}

export interface CheckoutResult {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Confirm a checkout straight from the browser callback. The server verifies the
 * signature and credits the wallet idempotently — this is what makes a payment
 * complete on localhost, where Razorpay cannot reach the webhook.
 */
export function verifyPayment(result: CheckoutResult) {
  return postJson<{ ok: boolean; credited: boolean; alreadyCredited: boolean }>(
    '/api/billing/verify',
    result,
  );
}

export function cancelSubscription() {
  return postJson<{ cancelAtPeriodEnd: boolean }>('/api/billing/subscription/cancel', {});
}

export function resumeSubscription() {
  return postJson<{ cancelAtPeriodEnd: boolean }>('/api/billing/subscription/resume', {});
}

// ---- formatting helpers (integer-safe) ----

/** ₹ from paise. Integer paise in, formatted rupees out. */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Thousands-separated credits. */
export function formatCredits(credits: number): string {
  return credits.toLocaleString('en-IN');
}
