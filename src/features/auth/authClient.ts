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
  /** True when the server runs with AUTH_ENABLED=false (local development). */
  authDisabled: boolean;
}

export const SIGNED_OUT: SessionState = {
  authenticated: false,
  userId: null,
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

  const body = (await response.json()) as {
    authenticated?: boolean;
    user?: { id?: string };
    authDisabled?: boolean;
  };

  return {
    authenticated: Boolean(body.authenticated),
    userId: body.user?.id ?? null,
    authDisabled: Boolean(body.authDisabled),
  };
}

/** Exchange the operator password for a session cookie. */
export async function login(password: string): Promise<SessionState> {
  const response = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });

  if (response.status === 401) {
    throw new AuthError('Incorrect password.', 401, 'invalid_credentials');
  }
  if (response.status === 429) {
    throw new AuthError('Too many attempts. Wait a moment and try again.', 429, 'rate_limited');
  }
  if (!response.ok) {
    throw new AuthError(`Sign in failed (${response.status}).`, response.status, 'login_failed');
  }

  const body = (await response.json()) as {
    authenticated?: boolean;
    user?: { id?: string };
    authDisabled?: boolean;
  };

  return {
    authenticated: Boolean(body.authenticated),
    userId: body.user?.id ?? null,
    authDisabled: Boolean(body.authDisabled),
  };
}

/** Clear the session cookie. */
export async function logout(): Promise<void> {
  await fetch(apiUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'same-origin',
  });
}
