import React from 'react';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowCanvas } from '@features/workflow/components/WorkflowCanvas';
import 'reactflow/dist/style.css';

export default function App() {
    return (
        <ReactFlowProvider>
            <WorkflowCanvas />
        </ReactFlowProvider>
    );
}
