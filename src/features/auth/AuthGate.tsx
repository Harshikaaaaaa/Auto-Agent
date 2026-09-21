import React, { useCallback, useEffect, useState } from 'react';
import {
  AuthError,
  fetchSession,
  login,
  signup,
  SIGNED_OUT,
  type SessionState,
} from './authClient';

/**
 * Gates the app behind a session.
 *
 * Every API route except /healthz and the auth endpoints requires a session, so
 * without this the app would render and then fail every request with a 401.
 *
 * Accounts are email + password (Phase 1 of the SaaS work). A visitor can sign
 * in or create an account here; a new account is provisioned with free credits
 * and the Free plan server-side.
 */

type Status = 'checking' | 'signed-out' | 'signed-in' | 'unreachable';
type Mode = 'login' | 'signup';

interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [status, setStatus] = useState<Status>('checking');
  const [session, setSession] = useState<SessionState>(SIGNED_OUT);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const check = useCallback(async () => {
    try {
      const next = await fetchSession();
      setSession(next);
      setStatus(next.authenticated ? 'signed-in' : 'signed-out');
    } catch (err) {
      if (err instanceof AuthError && err.code === 'network_error') {
        setStatus('unreachable');
        return;
      }
      setStatus('signed-out');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        const next =
          mode === 'signup' ? await signup(email, password) : await login(email, password);
        setSession(next);
        setStatus('signed-in');
        // Do not keep the password in component state after use.
        setPassword('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign in failed.');
      } finally {
        setSubmitting(false);
      }
    },
    [mode, email, password],
  );

  if (status === 'checking') {
    return (
      <Centered>
        <p style={{ color: '#9ca3af', fontSize: 13 }}>Checking your session…</p>
      </Centered>
    );
  }

  if (status === 'unreachable') {
    return (
      <Centered>
        <h1 style={heading}>Cannot reach the server</h1>
        <p style={body}>
          The AutoAgent API is not responding. Start it with{' '}
          <code style={code}>npm run server</code> and try again.
        </p>
        <button type="button" style={primaryButton} onClick={() => void check()}>
          Retry
        </button>
      </Centered>
    );
  }

  if (status === 'signed-out') {
    const isSignup = mode === 'signup';
    const canSubmit = email.length > 0 && password.length >= (isSignup ? 8 : 1);
    return (
      <Centered>
        <h1 style={heading}>{isSignup ? 'Create your account' : 'Sign in'}</h1>
        <p style={body}>
          {isSignup
            ? 'New accounts start on the Free plan with signup credits included.'
            : 'AutoAgent can send email, post messages, and change saved data, so it requires a sign in.'}
        </p>
        <form onSubmit={handleSubmit} style={{ marginTop: 18 }}>
          <label htmlFor="autoagent-email" style={label}>
            Email
          </label>
          <input
            id="autoagent-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={input}
            autoFocus
          />
          <label htmlFor="autoagent-password" style={{ ...label, marginTop: 14 }}>
            Password
          </label>
          <input
            id="autoagent-password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={input}
          />
          {isSignup && (
            <p style={{ ...body, fontSize: 11, marginTop: 6 }}>At least 8 characters.</p>
          )}
          {error && (
            <p role="alert" style={{ ...body, color: '#fca5a5', marginTop: 10 }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !canSubmit}
            style={{
              ...primaryButton,
              marginTop: 16,
              width: '100%',
              opacity: submitting || !canSubmit ? 0.5 : 1,
            }}
          >
            {submitting
              ? isSignup
                ? 'Creating account…'
                : 'Signing in…'
              : isSignup
                ? 'Create account'
                : 'Sign in'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setMode(isSignup ? 'login' : 'signup');
            setError(null);
          }}
          style={linkButton}
        >
          {isSignup ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </Centered>
    );
  }

  return (
    <>
      {session.authDisabled && (
        <div role="status" style={devBanner}>
          Authentication is disabled on this server (development mode). Do not expose this
          deployment.
        </div>
      )}
      {children}
    </>
  );
}

// ---------------------------------------------------------------- presentation

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#050505',
        padding: 24,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>{children}</div>
    </div>
  );
}

const heading: React.CSSProperties = {
  color: '#fff',
  fontSize: 20,
  fontWeight: 700,
  marginBottom: 8,
};

const body: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: 13,
  lineHeight: 1.6,
  margin: 0,
};

const label: React.CSSProperties = {
  display: 'block',
  color: '#9ca3af',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  marginBottom: 6,
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #1a1a1a',
  background: '#111',
  color: '#e5e7eb',
  fontSize: 14,
};

const primaryButton: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 10,
  border: 'none',
  background: '#2dd4bf',
  color: '#000',
  fontWeight: 700,
  fontSize: 12,
  cursor: 'pointer',
};

const code: React.CSSProperties = {
  background: '#111',
  padding: '2px 6px',
  borderRadius: 6,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
};

const linkButton: React.CSSProperties = {
  marginTop: 16,
  background: 'none',
  border: 'none',
  color: '#5eead4',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
};

const devBanner: React.CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  background: '#78350f',
  color: '#fde68a',
  fontSize: 11,
  padding: '6px 12px',
  textAlign: 'center',
  fontFamily: 'Inter, sans-serif',
};
