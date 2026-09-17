import React, { useState } from 'react';
import { Node, Edge } from 'reactflow';
import { useWorkflowExecutionLangGraph } from '@features/workflow/hooks/useWorkflowExecutionLangGraph';
import { workflowCheckpointManager, humanInTheLoopWorkflow } from '@features/workflow/services/checkpointManager';

interface LangGraphDemoProps {
    nodes: Node[];
    edges: Edge[];
    setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void;
}

/**
 * Demo component showcasing LangGraph features:
 * - Enhanced state management
 * - Execution history tracking
 * - Checkpointing & resume
 * - Human-in-the-loop approvals
 */
export const LangGraphDemo: React.FC<LangGraphDemoProps> = ({ nodes, edges, setNodes }) => {
    const [threadId, setThreadId] = useState<string>('');
    const [, setCheckpointData] = useState<string>('');
    const [pendingApprovals, setPendingApprovals] = useState<any[]>([]);

    const {
        isExecuting,
        executionLogs,
        langGraphState,
        executeFlow,
        clearLogs,
        getExecutionHistory,
        getStateSnapshot
    } = useWorkflowExecutionLangGraph(nodes, edges, setNodes);

    // === Basic Execution ===
    const handleBasicExecution = async () => {
        console.log('[LangGraph] Starting basic execution...');
        const result = await executeFlow();

        if (result) {
            console.log('[LangGraph] Execution completed:', result.success);

            // Access execution history
            const history = getExecutionHistory();
            console.log('[LangGraph] Execution history:', history);

            // Get state snapshot
            const snapshot = getStateSnapshot();
            console.log('[LangGraph] State snapshot:', snapshot);
        }
    };

    // === Checkpointed Execution ===
    const handleCheckpointedExecution = async () => {
        const newThreadId = `workflow-${Date.now()}`;
        setThreadId(newThreadId);

        console.log('[LangGraph] Starting checkpointed execution...');

        // Extract initial state from nodes
        const initialData: Record<string, any> = {};
        nodes.forEach(n => {
            if (n.data.initialState) {
                Object.assign(initialData, n.data.initialState);
            }
        });

        const originalPrompt = (initialData as any).user_request || '';

        const result = await workflowCheckpointManager.executeWithCheckpoints(
            nodes,
            edges,
            initialData,
            originalPrompt,
            newThreadId
        );

        console.log('[LangGraph] Execution with checkpoints completed');
        console.log('Final state:', result.finalState);
        console.log('Checkpoints:', result.checkpoints.length);
        console.log('Thread ID:', result.threadId);

        // Export checkpoint for later resume
        const exported = await workflowCheckpointManager.exportCheckpoint(newThreadId);
        setCheckpointData(exported);
    };

    // === Resume from Checkpoint ===
    const handleResumeFromCheckpoint = async () => {
        if (!threadId) {
            alert('No checkpoint available. Run a checkpointed execution first.');
            return;
        }

        console.log('[LangGraph] Resuming from checkpoint:', threadId);

        const originalPrompt = '';
        const finalState = await workflowCheckpointManager.resumeFromCheckpoint(
            nodes,
            edges,
            threadId,
            originalPrompt
        );

        console.log('[LangGraph] Resumed execution completed:', finalState);
    };

    // === View Thread History ===
    const handleViewThreadHistory = async () => {
        if (!threadId) {
            alert('No thread ID available.');
            return;
        }

        const history = await workflowCheckpointManager.getThreadHistory(threadId);
        console.log('[LangGraph] Thread history:', history);
        alert(`Thread has ${history.length} checkpoints. Check console for details.`);
    };

    // === Human-in-the-Loop: Check Pending Approvals ===
    const handleCheckPendingApprovals = () => {
        const approvals = humanInTheLoopWorkflow.getPendingApprovals();
        setPendingApprovals(approvals);
        console.log('[LangGraph] Pending approvals:', approvals);
    };

    // === Human-in-the-Loop: Approve ===
    const handleApprove = (approvalId: string) => {
        const success = humanInTheLoopWorkflow.approve(approvalId, {
            approvedBy: 'user@example.com',
            timestamp: new Date().toISOString()
        });
        console.log('[LangGraph] Approval result:', success);
        handleCheckPendingApprovals();
    };

    // === Human-in-the-Loop: Reject ===
    const handleReject = (approvalId: string) => {
        const success = humanInTheLoopWorkflow.reject(approvalId);
        console.log('[LangGraph] Rejection result:', success);
        handleCheckPendingApprovals();
    };

    // === Export/Import Checkpoint ===
    const handleExportCheckpoint = async () => {
        if (!threadId) {
            alert('No checkpoint to export.');
            return;
        }

        const data = await workflowCheckpointManager.exportCheckpoint(threadId);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `workflow-checkpoint-${threadId}.json`;
        a.click();
    };

    const handleImportCheckpoint = async (file: File) => {
        const text = await file.text();
        const newThreadId = `imported-${Date.now()}`;

        await workflowCheckpointManager.importCheckpoint(newThreadId, text);
        setThreadId(newThreadId);
        alert(`Checkpoint imported with thread ID: ${newThreadId}`);
    };

    return (
        <div style={{ padding: '20px', border: '1px solid #ccc', borderRadius: '8px', marginTop: '20px' }}>
            <h2>🚀 LangGraph Features Demo</h2>

            {/* Basic Execution */}
            <section style={{ marginBottom: '20px' }}>
                <h3>1. Basic Execution with Enhanced State</h3>
                <button
                    onClick={handleBasicExecution}
                    disabled={isExecuting || nodes.length === 0}
                    style={{ padding: '10px 20px', marginRight: '10px' }}
                >
                    {isExecuting ? 'Executing...' : 'Run Workflow'}
                </button>
                <button onClick={clearLogs} style={{ padding: '10px 20px' }}>
                    Clear Logs
                </button>

                {langGraphState && (
                    <div style={{ marginTop: '10px', padding: '10px', background: '#f5f5f5', borderRadius: '4px' }}>
                        <strong>State Info:</strong>
                        <div>Run ID: {langGraphState.metadata.runId}</div>
                        <div>Status: {langGraphState.metadata.status}</div>
                        <div>History Length: {langGraphState.history.length}</div>
                        <div>Logs: {langGraphState.logs.length}</div>
                    </div>
                )}
            </section>

            {/* Checkpointing */}
            <section style={{ marginBottom: '20px' }}>
                <h3>2. Checkpointing & Resume</h3>
                <button
                    onClick={handleCheckpointedExecution}
                    disabled={isExecuting || nodes.length === 0}
                    style={{ padding: '10px 20px', marginRight: '10px' }}
                >
                    Run with Checkpoints
                </button>
                <button
                    onClick={handleResumeFromCheckpoint}
                    disabled={!threadId}
                    style={{ padding: '10px 20px', marginRight: '10px' }}
                >
                    Resume from Checkpoint
                </button>
                <button
                    onClick={handleViewThreadHistory}
                    disabled={!threadId}
                    style={{ padding: '10px 20px' }}
                >
                    View Thread History
                </button>

                {threadId && (
                    <div style={{ marginTop: '10px', padding: '10px', background: '#e3f2fd', borderRadius: '4px' }}>
                        <strong>Current Thread ID:</strong> {threadId}
                    </div>
                )}
            </section>

            {/* Import/Export */}
            <section style={{ marginBottom: '20px' }}>
                <h3>3. Import/Export Checkpoints</h3>
                <button
                    onClick={handleExportCheckpoint}
                    disabled={!threadId}
                    style={{ padding: '10px 20px', marginRight: '10px' }}
                >
                    Export Checkpoint
                </button>
                <input
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleImportCheckpoint(file);
                    }}
                    style={{ padding: '10px' }}
                />
            </section>

            {/* Human-in-the-Loop */}
            <section style={{ marginBottom: '20px' }}>
                <h3>4. Human-in-the-Loop Approvals</h3>
                <button
                    onClick={handleCheckPendingApprovals}
                    style={{ padding: '10px 20px', marginBottom: '10px' }}
                >
                    Check Pending Approvals
                </button>

                {pendingApprovals.length > 0 && (
                    <div style={{ marginTop: '10px' }}>
                        {pendingApprovals.map((approval) => (
                            <div
                                key={approval.id}
                                style={{
                                    padding: '10px',
                                    background: '#fff3e0',
                                    borderRadius: '4px',
                                    marginBottom: '10px'
                                }}
                            >
                                <div><strong>Approval ID:</strong> {approval.id}</div>
                                <div><strong>Node:</strong> {approval.nodeId}</div>
                                <button
                                    onClick={() => handleApprove(approval.id)}
                                    style={{ padding: '8px 16px', marginRight: '10px', background: '#4caf50', color: 'white', border: 'none', borderRadius: '4px' }}
                                >
                                    Approve
                                </button>
                                <button
                                    onClick={() => handleReject(approval.id)}
                                    style={{ padding: '8px 16px', background: '#f44336', color: 'white', border: 'none', borderRadius: '4px' }}
                                >
                                    Reject
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Execution Logs */}
            {executionLogs.length > 0 && (
                <section>
                    <h3>5. Execution Logs</h3>
                    <div style={{ maxHeight: '300px', overflow: 'auto', background: '#f5f5f5', padding: '10px', borderRadius: '4px' }}>
                        {executionLogs.map((log, i) => (
                            <div key={i} style={{ marginBottom: '10px', padding: '10px', background: 'white', borderRadius: '4px' }}>
                                <div><strong>{log.node}</strong> - {log.time}</div>
                                <pre style={{ fontSize: '12px', margin: '5px 0' }}>{log.output}</pre>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
};

export default LangGraphDemo;
