import { ReactFlowProvider } from 'reactflow';
import { WorkflowCanvas } from '@features/workflow/components/WorkflowCanvas';
import { ErrorBoundary } from './ErrorBoundary';
import 'reactflow/dist/style.css';

export default function App() {
  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <WorkflowCanvas />
      </ReactFlowProvider>
    </ErrorBoundary>
  );
}
