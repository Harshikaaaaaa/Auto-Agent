import crypto from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Pure Razorpay crypto: webhook + checkout signature verification. No network.
 * The security-critical property is that a wrong signature never verifies and a
 * malformed one never throws.
 */

const originalEnv = { ...process.env };
const WEBHOOK_SECRET = 'whsec_test_value_0123456789';
const KEY_SECRET = 'rzp_secret_test_0123456789';

async function loadRazorpay(overrides = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'a'.repeat(64),
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  });
  vi.resetModules();
  return import('../razorpay.js');
}

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly-signed raw body and rejects a tampered one', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    const rawBody = JSON.stringify({ event: 'payment.captured', payload: {} });
    const good = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

    expect(verifyWebhookSignature(rawBody, good)).toBe(true);
    // A body the attacker changed after signing must not verify.
    expect(verifyWebhookSignature(rawBody + 'x', good)).toBe(false);
    // A signature from the wrong secret must not verify.
    const wrong = crypto.createHmac('sha256', 'other-secret').update(rawBody).digest('hex');
    expect(verifyWebhookSignature(rawBody, wrong)).toBe(false);
  });

  it('never throws on a malformed signature and is false without a secret', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    expect(verifyWebhookSignature('body', undefined)).toBe(false);
    expect(verifyWebhookSignature('body', 'not-hex-zz')).toBe(false);
    expect(verifyWebhookSignature('body', '')).toBe(false);

    const noSecret = await loadRazorpay({ RAZORPAY_WEBHOOK_SECRET: '' });
    expect(noSecret.verifyWebhookSignature('body', 'abcd')).toBe(false);
  });
});

describe('verifyPaymentSignature (checkout handshake)', () => {
  it('verifies the order|payment signature keyed by the key secret', async () => {
    const { verifyPaymentSignature } = await loadRazorpay();
    const orderId = 'order_123';
    const paymentId = 'pay_456';
    const signature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    expect(verifyPaymentSignature({ orderId, paymentId, signature })).toBe(true);
    expect(verifyPaymentSignature({ orderId, paymentId, signature: 'deadbeef' })).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('normalizes a payment.captured event', async () => {
    const { parseWebhook } = await loadRazorpay();
    const parsed = parseWebhook({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 9900 } },
      },
    });
    expect(parsed).toMatchObject({
      event: 'payment.captured',
      paymentId: 'pay_1',
      orderId: 'order_1',
      status: 'captured',
      amountPaise: 9900,
    });
  });
});

describe('isConfigured', () => {
  it('is false without both key id and secret', async () => {
    const yes = await loadRazorpay();
    expect(yes.isConfigured()).toBe(true);
    const no = await loadRazorpay({ RAZORPAY_KEY_SECRET: '' });
    expect(no.isConfigured()).toBe(false);
  });
});
