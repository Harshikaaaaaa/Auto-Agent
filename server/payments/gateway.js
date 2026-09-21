/**
 * Payment-gateway abstraction.
 *
 * The billing layer talks to THIS interface, never to a specific provider, so
 * Cashfree or Stripe can be added later by writing another implementation and
 * swapping the export in index.js — no route or repository changes.
 *
 * A gateway implementation must provide:
 *
 *   isConfigured(): boolean
 *     Whether the gateway has its credentials. When false the payment routes
 *     answer 503 rather than pretending to work.
 *
 *   async createOrder({ amountPaise, currency, receipt, notes }):
 *     Create an order/intent at the gateway and return
 *     { orderId, amountPaise, currency, keyId } — keyId is the PUBLIC key the
 *     browser checkout needs (never the secret).
 *
 *   verifyWebhookSignature(rawBody, signatureHeader): boolean
 *     Constant-time HMAC verification of a webhook. The RAW request body must be
 *     passed (not the parsed object), because the signature is over the exact
 *     bytes the gateway sent.
 *
 *   parseWebhook(body): { event, paymentId, orderId, status, amountPaise }
 *     Normalise a verified webhook into the fields the billing layer acts on.
 *
 * NEVER TRUST THE FRONTEND: credits are granted only from a verified webhook,
 * never from a browser "payment succeeded" callback.
 */

/** Raised when a payment gateway is asked to act without being configured. */
export class GatewayNotConfiguredError extends Error {
  constructor(gateway) {
    super(`The ${gateway} payment gateway is not configured on the server.`);
    this.name = 'GatewayNotConfiguredError';
    this.status = 503;
  }
}
