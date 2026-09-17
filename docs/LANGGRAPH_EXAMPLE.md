# Complete LangGraph Example

This file demonstrates a complete, working example of using LangGraph in AutoAgent.

## Example Workflow: Customer Feedback Analysis

This workflow:
1. Receives customer feedback
2. Analyzes sentiment and themes
3. Generates a summary report
4. Requires approval
5. Sends email to stakeholders

## Step 1: Define the Workflow

```typescript
// Example workflow structure
const exampleWorkflow = {
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      position: { x: 0, y: 0 },
      data: {
        label: 'Receive Feedback',
        type: 'trigger',
        description: 'Initialize workflow with customer feedback',
        initialState: {
          customer_feedback: "The product is great but the UI could be more intuitive.",
          customer_email: "customer@example.com",
          customer_name: "John Doe"
        },
        stateContract: {
          inputKeys: [],
          outputKeys: ['customer_feedback', 'customer_email', 'customer_name'],
          reducer: 'overwrite'
        }
      }
    },
    {
      id: 'analyze',
      type: 'ai_agent',
      position: { x: 0, y: 250 },
      data: {
        label: 'Analyze Feedback',
        type: 'ai_agent',
        description: 'Analyze the sentiment and extract key themes from the feedback',
        stateContract: {
          inputKeys: ['customer_feedback'],
          outputKeys: ['sentiment', 'key_themes', 'priority_level'],
          reducer: 'overwrite'
        }
      }
    },
    {
      id: 'summarize',
      type: 'ai_agent',
      position: { x: 0, y: 500 },
      data: {
        label: 'Generate Summary',
        type: 'ai_agent',
        description: 'Create a concise summary report for stakeholders',
        stateContract: {
          inputKeys: ['customer_feedback', 'sentiment', 'key_themes', 'customer_name'],
          outputKeys: ['summary_report'],
          reducer: 'overwrite'
        }
      }
    },
    {
      id: 'compose_email',
      type: 'ai_agent',
      position: { x: 0, y: 750 },
      data: {
        label: 'Compose Email',
        type: 'ai_agent',
        description: 'Draft an email to stakeholders with the summary',
        stateContract: {
          inputKeys: ['summary_report', 'priority_level'],
          outputKeys: ['email_subject', 'email_body'],
          reducer: 'overwrite'
        }
      }
    },
    {
      id: 'send_email',
      type: 'tool',
      position: { x: 0, y: 1000 },
      data: {
        label: 'Send Email',
        type: 'tool',
        description: 'Send the summary email',
        toolId: 'gmail',
        toolAction: 'send_email',
        configuredRecipient: 'stakeholders@company.com',
        stateContract: {
          inputKeys: ['email_subject', 'email_body'],
          outputKeys: ['email_status', 'message_id'],
          reducer: 'overwrite'
        }
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'analyze' },
    { id: 'e2', source: 'analyze', target: 'summarize' },
    { id: 'e3', source: 'summarize', target: 'compose_email' },
    { id: 'e4', source: 'compose_email', target: 'send_email' }
  ]
};
```

## Step 2: Execute with Basic Hook

```typescript
import React, { useState } from 'react';
import { useWorkflowExecutionLangGraph } from '@features/workflow/hooks/useWorkflowExecutionLangGraph';

function FeedbackWorkflow() {
  const [nodes, setNodes] = useState(exampleWorkflow.nodes);
  const [edges, setEdges] = useState(exampleWorkflow.edges);

  const {
    isExecuting,
    executionLogs,
    graphState,
    langGraphState,
    executeFlow,
    clearLogs,
    getExecutionHistory,
    getStateSnapshot
  } = useWorkflowExecutionLangGraph(nodes, edges, setNodes);

  const handleExecute = async () => {
    console.log('[Workflow] Starting execution...');
    const result = await executeFlow();
    
    if (result?.success) {
      console.log('[Workflow] ✅ Completed successfully!');
      
      // Access the execution history
      const history = getExecutionHistory();
      console.log('[History] Executed nodes:', history.map(h => h.nodeLabel));
      
      // Get final state snapshot
      const snapshot = getStateSnapshot();
      console.log('[Snapshot] Final state:', snapshot);
      
      // Access specific outputs
      console.log('[Output] Sentiment:', snapshot?.data.sentiment);
      console.log('[Output] Themes:', snapshot?.data.key_themes);
      console.log('[Output] Email status:', snapshot?.data.email_status);
    } else {
      console.error('[Workflow] ❌ Failed:', result?.finalState.metadata.error);
    }
  };

  return (
    <div>
      <h2>Customer Feedback Analysis Workflow</h2>
      
      <button onClick={handleExecute} disabled={isExecuting}>
        {isExecuting ? 'Running...' : 'Analyze Feedback'}
      </button>
      
      <button onClick={clearLogs}>Clear Logs</button>

      {/* State Display */}
      {langGraphState && (
        <div style={{ marginTop: '20px', padding: '15px', background: '#f0f0f0' }}>
          <h3>Workflow State</h3>
          <p><strong>Status:</strong> {langGraphState.metadata.status}</p>
          <p><strong>Run ID:</strong> {langGraphState.metadata.runId}</p>
          <p><strong>Steps Executed:</strong> {langGraphState.history.length}</p>
          
          {graphState && (
            <div>
              <h4>Results:</h4>
              <p><strong>Sentiment:</strong> {graphState.sentiment}</p>
              <p><strong>Themes:</strong> {graphState.key_themes}</p>
              <p><strong>Priority:</strong> {graphState.priority_level}</p>
            </div>
          )}
        </div>
      )}

      {/* Execution Logs */}
      <div style={{ marginTop: '20px' }}>
        <h3>Execution Logs</h3>
        {executionLogs.map((log, i) => (
          <div key={i} style={{ 
            padding: '10px', 
            marginBottom: '10px', 
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px'
          }}>
            <div><strong>{log.node}</strong> - {log.time}</div>
            <pre style={{ fontSize: '12px', overflow: 'auto' }}>
              {log.output}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Step 3: Execute with Checkpointing

```typescript
import { workflowCheckpointManager } from '@features/workflow/services/checkpointManager';

async function executeWithCheckpoints() {
  const threadId = `feedback-${Date.now()}`;
  
  console.log('[Checkpoint] Starting workflow with checkpointing...');
  
  const result = await workflowCheckpointManager.executeWithCheckpoints(
    exampleWorkflow.nodes,
    exampleWorkflow.edges,
    {}, // Initial state comes from trigger node
    'Analyze customer feedback and notify stakeholders',
    threadId
  );

  console.log('[Checkpoint] ✅ Workflow completed!');
  console.log('[Checkpoint] Thread ID:', result.threadId);
  console.log('[Checkpoint] Checkpoints saved:', result.checkpoints.length);
  console.log('[Checkpoint] Final state:', result.finalState);

  // Export checkpoint for later use
  const checkpointData = await workflowCheckpointManager.exportCheckpoint(threadId);
  localStorage.setItem(`checkpoint-${threadId}`, checkpointData);
  console.log('[Checkpoint] Saved to localStorage');

  return { threadId, result };
}

// Resume from a previous checkpoint
async function resumeWorkflow(threadId: string) {
  console.log('[Checkpoint] Resuming from thread:', threadId);
  
  const finalState = await workflowCheckpointManager.resumeFromCheckpoint(
    exampleWorkflow.nodes,
    exampleWorkflow.edges,
    threadId,
    'Analyze customer feedback and notify stakeholders'
  );

  console.log('[Checkpoint] ✅ Resumed and completed!');
  console.log('[Checkpoint] Final state:', finalState);
  
  return finalState;
}
```

## Step 4: Add Human Approval

```typescript
import { humanInTheLoopWorkflow } from '@features/workflow/services/checkpointManager';

// Modified workflow with approval step
const workflowWithApproval = {
  ...exampleWorkflow,
  nodes: [
    ...exampleWorkflow.nodes,
    {
      id: 'approval',
      type: 'logic',
      position: { x: 0, y: 875 },
      data: {
        label: 'Require Approval',
        type: 'logic',
        description: 'Wait for human approval before sending email',
        requiresApproval: true,
        stateContract: {
          inputKeys: ['email_subject', 'email_body'],
          outputKeys: ['approved', 'approval_data'],
          reducer: 'overwrite'
        }
      }
    }
  ]
};

// In your component
function WorkflowWithApproval() {
  const [pendingApprovals, setPendingApprovals] = useState([]);

  // Check for pending approvals periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const approvals = humanInTheLoopWorkflow.getPendingApprovals();
      setPendingApprovals(approvals);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleApprove = (approvalId: string) => {
    humanInTheLoopWorkflow.approve(approvalId, {
      approvedBy: 'manager@company.com',
      timestamp: new Date().toISOString(),
      comments: 'Looks good, proceed'
    });
    console.log('[Approval] ✅ Approved:', approvalId);
  };

  const handleReject = (approvalId: string) => {
    humanInTheLoopWorkflow.reject(approvalId);
    console.log('[Approval] ❌ Rejected:', approvalId);
  };

  return (
    <div>
      <h3>Pending Approvals</h3>
      {pendingApprovals.length === 0 ? (
        <p>No pending approvals</p>
      ) : (
        pendingApprovals.map(approval => (
          <div key={approval.id} style={{
            padding: '15px',
            margin: '10px 0',
            background: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '4px'
          }}>
            <h4>Approval Required</h4>
            <p><strong>Node:</strong> {approval.nodeId}</p>
            <p><strong>Email Subject:</strong> {approval.state.data.email_subject}</p>
            <pre style={{ 
              background: 'white', 
              padding: '10px',
              borderRadius: '4px',
              maxHeight: '200px',
              overflow: 'auto'
            }}>
              {approval.state.data.email_body}
            </pre>
            
            <div style={{ marginTop: '10px' }}>
              <button 
                onClick={() => handleApprove(approval.id)}
                style={{
                  padding: '10px 20px',
                  marginRight: '10px',
                  background: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Approve
              </button>
              <button 
                onClick={() => handleReject(approval.id)}
                style={{
                  padding: '10px 20px',
                  background: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Reject
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
```

## Step 5: Complete Flow with All Features

```typescript
import React, { useState, useEffect } from 'react';
import { useWorkflowExecutionLangGraph } from '@features/workflow/hooks/useWorkflowExecutionLangGraph';
import { workflowCheckpointManager, humanInTheLoopWorkflow } from '@features/workflow/services/checkpointManager';

function CompleteWorkflowExample() {
  const [nodes, setNodes] = useState(exampleWorkflow.nodes);
  const [edges, setEdges] = useState(exampleWorkflow.edges);
  const [threadId, setThreadId] = useState('');
  const [pendingApprovals, setPendingApprovals] = useState([]);

  const {
    isExecuting,
    executionLogs,
    graphState,
    langGraphState,
    executeFlow,
    clearLogs,
    getExecutionHistory,
    getStateSnapshot
  } = useWorkflowExecutionLangGraph(nodes, edges, setNodes);

  // Monitor for approvals
  useEffect(() => {
    const interval = setInterval(() => {
      setPendingApprovals(humanInTheLoopWorkflow.getPendingApprovals());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Basic execution
  const handleBasicRun = async () => {
    await executeFlow();
  };

  // Execution with checkpointing
  const handleCheckpointRun = async () => {
    const newThreadId = `workflow-${Date.now()}`;
    setThreadId(newThreadId);

    const result = await workflowCheckpointManager.executeWithCheckpoints(
      nodes,
      edges,
      {},
      'Analyze customer feedback',
      newThreadId
    );

    console.log('Checkpointed execution complete:', result);
  };

  // Resume from checkpoint
  const handleResume = async () => {
    if (!threadId) {
      alert('No checkpoint to resume from');
      return;
    }

    const finalState = await workflowCheckpointManager.resumeFromCheckpoint(
      nodes,
      edges,
      threadId,
      'Analyze customer feedback'
    );

    console.log('Resumed execution complete:', finalState);
  };

  // Export checkpoint
  const handleExport = async () => {
    if (!threadId) return;
    
    const data = await workflowCheckpointManager.exportCheckpoint(threadId);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-checkpoint-${threadId}.json`;
    a.click();
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Complete Workflow Example</h1>

      {/* Control Panel */}
      <div style={{ marginBottom: '20px' }}>
        <h3>Controls</h3>
        <button onClick={handleBasicRun} disabled={isExecuting}>
          Basic Run
        </button>
        <button onClick={handleCheckpointRun} disabled={isExecuting}>
          Run with Checkpoints
        </button>
        <button onClick={handleResume} disabled={!threadId || isExecuting}>
          Resume from Checkpoint
        </button>
        <button onClick={handleExport} disabled={!threadId}>
          Export Checkpoint
        </button>
        <button onClick={clearLogs}>
          Clear Logs
        </button>
      </div>

      {/* Status Display */}
      {langGraphState && (
        <div style={{ 
          padding: '15px', 
          background: '#e3f2fd', 
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <h3>Workflow Status</h3>
          <div><strong>Status:</strong> {langGraphState.metadata.status}</div>
          <div><strong>Run ID:</strong> {langGraphState.metadata.runId}</div>
          <div><strong>Thread ID:</strong> {threadId || 'N/A'}</div>
          <div><strong>Steps:</strong> {langGraphState.history.length}</div>
        </div>
      )}

      {/* Approvals */}
      {pendingApprovals.length > 0 && (
        <div style={{ 
          padding: '15px', 
          background: '#fff3cd', 
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <h3>Pending Approvals ({pendingApprovals.length})</h3>
          {pendingApprovals.map(approval => (
            <div key={approval.id} style={{ marginBottom: '10px' }}>
              <p><strong>Node:</strong> {approval.nodeId}</p>
              <button onClick={() => humanInTheLoopWorkflow.approve(approval.id)}>
                Approve
              </button>
              <button onClick={() => humanInTheLoopWorkflow.reject(approval.id)}>
                Reject
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Execution Logs */}
      <div>
        <h3>Execution Logs</h3>
        <div style={{ maxHeight: '400px', overflow: 'auto' }}>
          {executionLogs.map((log, i) => (
            <div key={i} style={{
              padding: '10px',
              marginBottom: '10px',
              background: 'white',
              border: '1px solid #ddd',
              borderRadius: '4px'
            }}>
              <div><strong>{log.node}</strong> - {log.time}</div>
              <pre style={{ fontSize: '12px' }}>{log.output}</pre>
            </div>
          ))}
        </div>
      </div>

      {/* Results */}
      {graphState && (
        <div style={{ 
          padding: '15px', 
          background: '#d4edda', 
          borderRadius: '8px',
          marginTop: '20px'
        }}>
          <h3>Results</h3>
          <pre>{JSON.stringify(graphState, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export default CompleteWorkflowExample;
```

## Expected Output

When you run this workflow, you'll see:

1. **Execution Logs** showing each node:
   ```
   Receive Feedback - 10:30:00 AM
   { customer_feedback: "...", customer_email: "...", ... }

   Analyze Feedback - 10:30:05 AM
   { sentiment: "Positive with concerns", key_themes: ["UI improvement"], ... }

   Generate Summary - 10:30:10 AM
   { summary_report: "Customer feedback analysis shows..." }

   Compose Email - 10:30:15 AM
   { email_subject: "Customer Feedback Summary", email_body: "..." }

   Send Email - 10:30:20 AM
   { email_status: "sent", message_id: "abc123" }
   ```

2. **State Snapshot**:
   ```json
   {
     "data": {
       "customer_feedback": "The product is great but...",
       "customer_email": "customer@example.com",
       "sentiment": "Positive with concerns",
       "key_themes": ["UI improvement", "positive feedback"],
       "priority_level": "medium",
       "summary_report": "...",
       "email_subject": "...",
       "email_body": "...",
       "email_status": "sent"
     },
     "metadata": {
       "runId": "uuid-123",
       "status": "completed",
       ...
     }
   }
   ```

3. **Execution History**:
   Each step tracked with inputs, outputs, and timestamps.

## Next Steps

1. Copy this example to your app
2. Customize the workflow nodes
3. Add your own tool integrations
4. Try checkpointing and resume
5. Implement approval workflows

Happy coding! 🚀
