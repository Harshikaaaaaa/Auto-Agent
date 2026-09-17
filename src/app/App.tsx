import { ReactFlowProvider } from 'reactflow';
import { WorkflowCanvas } from '@features/workflow/components/WorkflowCanvas';
import { AuthGate } from '@features/auth/AuthGate';
import { ErrorBoundary } from './ErrorBoundary';
import 'reactflow/dist/style.css';

export default function App() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <ReactFlowProvider>
          <WorkflowCanvas />
        </ReactFlowProvider>
      </AuthGate>
    </ErrorBoundary>
  );
}
