import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowCanvas } from '@features/workflow/components/WorkflowCanvas';
import { BillingApp } from '@features/billing/BillingApp';
import { AuthGate } from '@features/auth/AuthGate';
import { ErrorBoundary } from './ErrorBoundary';
import 'reactflow/dist/style.css';

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
          </Routes>
        </BrowserRouter>
      </AuthGate>
    </ErrorBoundary>
  );
}
