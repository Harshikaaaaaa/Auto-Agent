import type { GatewayOrder } from './billingClient';

/**
 * Launch the Razorpay Checkout popup for a created order.
 *
 * The server has already created the order (and a PENDING payment row); this
 * only opens the hosted checkout with that order id + the public key id. On a
 * successful payment Razorpay fires the `payment.captured` webhook, and THAT is
 * what actually credits the wallet / activates the plan server-side — the
 * browser is never trusted to grant anything. So `onClose` here just refreshes
 * the UI; it does not mean "paid".
 *
 * checkout.js is loaded on demand (not bundled) so the app has no hard runtime
 * dependency on Razorpay when payments are unused.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name?: string;
  description?: string;
  handler?: (response: RazorpaySuccess) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
  prefill?: { email?: string };
}

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, cb: (resp: unknown) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let scriptPromise: Promise<boolean> | null = null;

/** Load checkout.js once; resolves true when window.Razorpay is available. */
function loadRazorpayScript(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => {
      scriptPromise = null; // allow a retry on a later attempt
      resolve(false);
    };
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export interface CheckoutHandlers {
  /** Called after a successful in-popup payment (the webhook still confirms). */
  onSuccess?: (response: RazorpaySuccess) => void;
  /** Called when the user dismisses the popup without paying. */
  onDismiss?: () => void;
  /** Prefill the payer's email in the popup. */
  email?: string;
  /** What is being bought, shown in the popup. */
  description?: string;
}

export class CheckoutUnavailableError extends Error {
  constructor() {
    super('Could not load the Razorpay checkout. Check your connection and try again.');
    this.name = 'CheckoutUnavailableError';
  }
}

/**
 * Open the Razorpay popup for an order. Rejects with CheckoutUnavailableError
 * when checkout.js cannot load (e.g. offline).
 */
export async function openRazorpayCheckout(
  order: GatewayOrder,
  handlers: CheckoutHandlers = {},
): Promise<void> {
  const ready = await loadRazorpayScript();
  if (!ready || !window.Razorpay) throw new CheckoutUnavailableError();

  const rzp = new window.Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amountPaise,
    currency: order.currency,
    name: 'AutoAgent',
    description: handlers.description,
    prefill: handlers.email ? { email: handlers.email } : undefined,
    theme: { color: '#2dd4bf' },
    handler: (response) => handlers.onSuccess?.(response),
    modal: { ondismiss: () => handlers.onDismiss?.() },
  });
  rzp.open();
}
