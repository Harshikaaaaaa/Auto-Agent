import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowCanvas } from '@features/workflow/components/WorkflowCanvas';
import { BillingApp } from '@features/billing/BillingApp';
import { AdminApp } from '@features/admin/AdminApp';
import { AuthGate } from '@features/auth/AuthGate';
import { fetchSession } from '@features/auth/authClient';
import { ErrorBoundary } from './ErrorBoundary';
import 'reactflow/dist/style.css';

/**
 * Route guard for the admin console. The server enforces admin access on every
 * /api/admin route (requireAdmin → 403), so this is a UX guard, not the security
 * boundary: it keeps a non-admin from landing on a console that would only show
 * permission errors, and sends them back to the app.
 */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'admin' | 'denied'>('checking');
  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (!cancelled) setState(s.role === 'admin' || s.authDisabled ? 'admin' : 'denied');
      })
      .catch(() => {
        if (!cancelled) setState('denied');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0 text-sm text-white/40">
        Checking access…
      </div>
    );
  }
  if (state === 'denied') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <BrowserRouter>
          <Routes>
            {/* The workflow canvas is the default route, unchanged. */}
            <Route
              path="/"
              element={
                <ReactFlowProvider>
                  <WorkflowCanvas />
                </ReactFlowProvider>
              }
            />
            {/* Billing & usage area. */}
            <Route path="/billing/*" element={<BillingApp />} />
            {/* Admin console — admin sessions only. */}
            <Route
              path="/admin/*"
              element={
                <RequireAdmin>
                  <AdminApp />
                </RequireAdmin>
              }
            />
          </Routes>
        </BrowserRouter>
      </AuthGate>
    </ErrorBoundary>
  );
}
