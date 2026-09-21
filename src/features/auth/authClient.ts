import { apiUrl } from '@config/api';

/**
 * Client for the session endpoints.
 *
 * The session lives in an httpOnly cookie, so this module deliberately has no
 * way to read or store a token — it only asks the server who the caller is.
 * That is what keeps an XSS from stealing the session.
 */

export interface SessionState {
  authenticated: boolean;
  userId: string | null;
  email: string | null;
  role: 'user' | 'admin' | null;
  /** True when the server runs with AUTH_ENABLED=false (local development). */
  authDisabled: boolean;
}

export const SIGNED_OUT: SessionState = {
  authenticated: false,
  userId: null,
  email: null,
  role: null,
  authDisabled: false,
};

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/** Ask the server whether the current cookie is a valid session. */
export async function fetchSession(): Promise<SessionState> {
  let response: Response;
  try {
    response = await fetch(apiUrl('/api/auth/me'), { credentials: 'same-origin' });
  } catch (cause) {
    throw new AuthError('Could not reach the AutoAgent server.', 0, 'network_error', { cause });
  }

  if (response.status === 401) return SIGNED_OUT;

  if (!response.ok) {
    throw new AuthError(
      `Could not read the session (${response.status}).`,
      response.status,
      'session_failed',
    );
  }

  return mapSession((await response.json()) as RawSession);
}

interface RawSession {
  authenticated?: boolean;
  user?: { id?: string; email?: string; role?: string };
  authDisabled?: boolean;
}

function mapSession(body: RawSession): SessionState {
  const role = body.user?.role;
  return {
    authenticated: Boolean(body.authenticated),
    userId: body.user?.id ?? null,
    email: body.user?.email ?? null,
    role: role === 'admin' ? 'admin' : role === 'user' ? 'user' : null,
    authDisabled: Boolean(body.authDisabled),
  };
}

/** Sign in with email + password, receiving a session cookie. */
export async function login(email: string, password: string): Promise<SessionState> {
  const response = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 401) {
    throw new AuthError('Incorrect email or password.', 401, 'invalid_credentials');
  }
  if (response.status === 403) {
    throw new AuthError('This account is not active.', 403, 'account_disabled');
  }
  if (response.status === 429) {
    throw new AuthError('Too many attempts. Wait a moment and try again.', 429, 'rate_limited');
  }
  if (!response.ok) {
    throw new AuthError(`Sign in failed (${response.status}).`, response.status, 'login_failed');
  }

  return mapSession(await response.json());
}

/** Create an account and receive a session cookie. */
export async function signup(email: string, password: string): Promise<SessionState> {
  const response = await fetch(apiUrl('/api/auth/signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 409) {
    throw new AuthError('An account with that email already exists.', 409, 'email_taken');
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new AuthError(body.message ?? 'Check your email and password.', 400, 'invalid_request');
  }
  if (response.status === 429) {
    throw new AuthError('Too many attempts. Wait a moment and try again.', 429, 'rate_limited');
  }
  if (!response.ok) {
    throw new AuthError(`Sign up failed (${response.status}).`, response.status, 'signup_failed');
  }

  return mapSession(await response.json());
}

/** Clear the session cookie. */
export async function logout(): Promise<void> {
  await fetch(apiUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'same-origin',
  });
}
