# LangGraph Integration Guide

## Overview

AutoAgent now uses **LangGraph** for enhanced state management, memory, and workflow execution. LangGraph provides:

1. **Managed State Graph** - Built-in state management across nodes
2. **Checkpointing** - Save and resume workflow execution
3. **Memory & Context** - Better cross-node awareness
4. **Human-in-the-loop** - Pause workflows for approval
5. **Streaming** - Real-time execution updates

## Architecture Changes

### Before (Custom Implementation)
```typescript
// Manual topological sort
// Custom state merging logic
// No checkpointing
// Limited error recovery
```

### After (LangGraph)
```typescript
// Built-in graph execution engine
// Type-safe state management
// Automatic checkpointing
// Better error handling and retry
```

## Usage Examples

### 1. Basic Workflow Execution with LangGraph

```typescript
import { useWorkflowExecutionLangGraph } from '@features/workflow/hooks/useWorkflowExecutionLangGraph';

function WorkflowCanvas() {
  const { 
    isExecuting, 
    executionLogs, 
    graphState,
    executeFlow,
    getExecutionHistory,
    getStateSnapshot
  } = useWorkflowExecutionLangGraph(nodes, edges, setNodes);

  const handleExecute = async () => {
    const result = await executeFlow();
    
    // Access execution history
    const history = getExecutionHistory();
    console.log('Execution history:', history);
    
    // Get complete state snapshot
    const snapshot = getStateSnapshot();
    console.log('State snapshot:', snapshot);
  };

  return (
    <button onClick={handleExecute}>
      {isExecuting ? 'Running...' : 'Run Workflow'}
    </button>
  );
}
```

### 2. Workflow with Checkpointing

```typescript
import { workflowCheckpointManager } from '@features/workflow/services/checkpointManager';

async function executeWithCheckpoints() {
  const threadId = 'workflow-session-123';
  
  const result = await workflowCheckpointManager.executeWithCheckpoints(
    nodes,
    edges,
    initialState,
    originalPrompt,
    threadId
  );

  console.log('Final state:', result.finalState);
  console.log('Checkpoints:', result.checkpoints);
  
  // Save checkpoint data
  const checkpointData = await workflowCheckpointManager.exportCheckpoint(threadId);
  localStorage.setItem('workflow-checkpoint', checkpointData);
}

// Resume from checkpoint later
async function resumeWorkflow() {
  const threadId = 'workflow-session-123';
  
  const finalState = await workflowCheckpointManager.resumeFromCheckpoint(
    nodes,
    edges,
    threadId,
    originalPrompt
  );

  console.log('Resumed and completed:', finalState);
}
```

### 3. Human-in-the-Loop Workflow

```typescript
import { humanInTheLoopWorkflow } from '@features/workflow/services/checkpointManager';

// In your node execution logic
async function executeNodeWithApproval(nodeId: string, state: WorkflowStateType) {
  if (node.data.requiresApproval) {
    const approvalId = `approval-${nodeId}-${Date.now()}`;
    
    // Request human approval
    const result = await humanInTheLoopWorkflow.requestApproval(
      approvalId,
      nodeId,
      state,
      60000 // 60 second timeout
    );

    if (!result.approved) {
      throw new Error('User rejected the workflow');
    }

    // Use approval data if provided
    if (result.data) {
      state.data = { ...state.data, ...result.data };
    }
  }

  // Continue with node execution
  return executeNode(nodeId, state);
}

// In your UI
function ApprovalPanel() {
  const [pendingApprovals, setPendingApprovals] = useState([]);

  useEffect(() => {
    const interval = setInterval(() => {
      setPendingApprovals(humanInTheLoopWorkflow.getPendingApprovals());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = (approvalId: string) => {
    humanInTheLoopWorkflow.approve(approvalId, { 
      approvedBy: 'user@example.com',
      timestamp: new Date().toISOString()
    });
  };

  const handleReject = (approvalId: string) => {
    humanInTheLoopWorkflow.reject(approvalId);
  };

  return (
    <div>
      {pendingApprovals.map(approval => (
        <div key={approval.id}>
          <h3>Approval Required: {approval.nodeId}</h3>
          <button onClick={() => handleApprove(approval.id)}>Approve</button>
          <button onClick={() => handleReject(approval.id)}>Reject</button>
        </div>
      ))}
    </div>
  );
}
```

### 4. Advanced State Management

```typescript
import { WorkflowState } from '@features/workflow/services/langgraphExecutor';

// The state automatically tracks:
// - data: All workflow data with smart reducers
// - metadata: Execution status, runId, timestamps
// - history: Complete execution trail
// - logs: User-facing execution logs

function StateDebugger({ langGraphState }: { langGraphState: WorkflowStateType }) {
  return (
    <div>
      <h3>Workflow State</h3>
      
      {/* Current data */}
      <section>
        <h4>Data</h4>
        <pre>{JSON.stringify(langGraphState.data, null, 2)}</pre>
      </section>

      {/* Execution metadata */}
      <section>
        <h4>Metadata</h4>
        <p>Run ID: {langGraphState.metadata.runId}</p>
        <p>Status: {langGraphState.metadata.status}</p>
        <p>Started: {langGraphState.metadata.startedAt}</p>
      </section>

      {/* Execution history */}
      <section>
        <h4>History ({langGraphState.history.length} steps)</h4>
        {langGraphState.history.map((entry, i) => (
          <div key={i}>
            <strong>{entry.nodeLabel}</strong>
            <span> → {entry.outputKeys.join(', ')}</span>
            <pre>{JSON.stringify(entry.output, null, 2)}</pre>
          </div>
        ))}
      </section>
    </div>
  );
}
```

## Migration Guide

### Step 1: Update Your Imports

```typescript
// Old
import { useWorkflowExecution } from '@features/workflow/hooks/useWorkflowExecution';

// New
import { useWorkflowExecutionLangGraph } from '@features/workflow/hooks/useWorkflowExecutionLangGraph';
```

### Step 2: Update Hook Usage

The API is mostly the same, with additional features:

```typescript
// Old
const { isExecuting, executionLogs, graphState, executeFlow } = useWorkflowExecution(nodes, edges, setNodes);

// New
const { 
  isExecuting, 
  executionLogs, 
  graphState,
  langGraphState,      // NEW: Full LangGraph state
  executeFlow,
  getExecutionHistory, // NEW: Access execution trail
  getStateSnapshot     // NEW: Complete state snapshot
} = useWorkflowExecutionLangGraph(nodes, edges, setNodes);
```

### Step 3: Leverage New Features

```typescript
// After execution
const result = await executeFlow();

// Access rich execution history
const history = getExecutionHistory();
// [{ nodeLabel, nodeId, outputKeys, output, timestamp }, ...]

// Get complete state for debugging
const snapshot = getStateSnapshot();
// { data, metadata, history, logs }

// Use LangGraph-specific state if needed
if (langGraphState) {
  console.log('Original prompt:', langGraphState.originalPrompt);
  console.log('Execution history:', langGraphState.history);
}
```

## Benefits Summary

### 1. Better Memory Across Nodes
- Each node receives complete execution history
- Context buffer includes all previous node outputs
- AI agents can reference earlier decisions

### 2. Checkpointing & Persistence
- Save workflow state at any point
- Resume execution from checkpoints
- Time-travel debugging

### 3. Human-in-the-Loop
- Pause workflows for approval
- Inject human decisions
- Override AI outputs

### 4. Improved Error Handling
- Automatic retry mechanisms
- Better error propagation
- State recovery options

### 5. Streaming Execution
- Real-time node updates
- Progressive state changes
- Better UX for long-running workflows

## Advanced Features

### Conditional Edges (Coming Soon)
```typescript
// Define conditional routing based on state
graph.addConditionalEdges(
  'decision_node',
  (state) => state.data.decision,
  {
    'approve': 'approval_node',
    'reject': 'rejection_node',
    'review': 'review_node'
  }
);
```

### Parallel Execution (Coming Soon)
```typescript
// Execute multiple independent branches in parallel
graph.addParallelBranches([
  ['node_a', 'node_b'],
  ['node_c', 'node_d']
]);
```

### Custom State Reducers
```typescript
// Already supported via stateContract.reducer
{
  stateContract: {
    inputKeys: ['data'],
    outputKeys: ['results'],
    reducer: 'append' // 'overwrite' | 'append' | 'merge'
  }
}
```

## Troubleshooting

### Issue: Checkpoints not persisting
**Solution**: Ensure you're using the same `threadId` when resuming.

### Issue: State not updating in UI
**Solution**: Use the callback functions (`onStateUpdate`, `onLogUpdate`) for real-time updates.

### Issue: Memory usage growing
**Solution**: Clear old checkpoints periodically:
```typescript
await workflowCheckpointManager.clearThread(threadId);
```

## Next Steps

1. **Try the new hook**: Update one workflow to use `useWorkflowExecutionLangGraph`
2. **Add checkpointing**: Implement save/resume for long-running workflows
3. **Enable approvals**: Add human-in-the-loop for critical decisions
4. **Monitor state**: Use the state snapshot for debugging

## Resources

- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
- [State Management Guide](https://langchain-ai.github.io/langgraphjs/concepts/low_level/)
- [Checkpointing Tutorial](https://langchain-ai.github.io/langgraphjs/how-tos/persistence/)
