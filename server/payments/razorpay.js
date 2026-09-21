import crypto from 'crypto';
import { resolveString } from '../config/settingsService.js';
import { GatewayNotConfiguredError } from './gateway.js';

/**
 * Razorpay implementation of the payment-gateway interface.
 *
 * No SDK dependency: order creation is one authenticated REST call and webhook
 * verification is HMAC-SHA256 over the raw body, both of which the standard
 * library does. This keeps the image lean and the crypto auditable.
 *
 * The KEY SECRET and WEBHOOK SECRET never leave the server; only the public
 * KEY_ID is handed to the browser checkout.
 */

const GATEWAY = 'razorpay';
const API_BASE = 'https://api.razorpay.com/v1';

export function isConfigured() {
  return Boolean(resolveString('RAZORPAY_KEY_ID') && resolveString('RAZORPAY_KEY_SECRET'));
}

/**
 * Create a Razorpay order. Amount is in paise, as Razorpay expects.
 * @returns {Promise<{ orderId, amountPaise, currency, keyId }>}
 */
export async function createOrder(
  { amountPaise, currency = 'INR', receipt, notes } = {},
  { fetchImpl = fetch } = {},
) {
  if (!isConfigured()) throw new GatewayNotConfiguredError(GATEWAY);
  const amount = Math.round(Number(amountPaise));
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('createOrder requires a positive integer amount in paise');
  }

  const auth = Buffer.from(
    `${resolveString('RAZORPAY_KEY_ID')}:${resolveString('RAZORPAY_KEY_SECRET')}`,
  ).toString('base64');
  const res = await fetchImpl(`${API_BASE}/orders`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency, receipt, notes: notes ?? {} }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error(`Razorpay order creation failed (${res.status}). ${detail}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return {
    orderId: data.id,
    amountPaise: Number(data.amount),
    currency: data.currency,
    keyId: resolveString('RAZORPAY_KEY_ID'), // public — safe for the browser
  };
}

/**
 * Verify a Razorpay webhook signature. The signature is HMAC-SHA256 of the RAW
 * request body keyed by the webhook secret, hex-encoded, in the
 * `x-razorpay-signature` header. Constant-time comparison.
 *
 * @param {string|Buffer} rawBody  the exact bytes Razorpay POSTed
 * @param {string} signatureHeader the x-razorpay-signature value
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = resolveString('RAZORPAY_WEBHOOK_SECRET');
  if (!webhookSecret) return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  try {
    const a = Buffer.from(signatureHeader, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify the checkout callback signature (order_id|payment_id keyed by the KEY
 * SECRET). This is the browser-side handshake; it is NOT sufficient on its own
 * to grant credits — the webhook is authoritative — but it lets the UI show a
 * confident success state.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature } = {}) {
  const keySecret = resolveString('RAZORPAY_KEY_SECRET');
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Normalise a verified webhook body to the fields the billing layer acts on.
 * Razorpay nests the entity under payload.payment.entity (or .order.entity).
 */
export function parseWebhook(body) {
  const event = body?.event ?? null;
  const payment = body?.payload?.payment?.entity ?? {};
  const order = body?.payload?.order?.entity ?? {};
  return {
    event,
    paymentId: payment.id ?? null,
    orderId: payment.order_id ?? order.id ?? null,
    status: payment.status ?? order.status ?? null,
    amountPaise: payment.amount !== undefined ? Number(payment.amount) : null,
    notes: payment.notes ?? order.notes ?? {},
  };
}

export const gateway = 'razorpay';
