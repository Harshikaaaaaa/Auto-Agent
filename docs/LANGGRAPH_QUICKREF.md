# LangGraph Quick Reference

## 🚀 Quick Start

### 1. Use the New Hook
```typescript
import { useWorkflowExecutionLangGraph } from '@features/workflow/hooks/useWorkflowExecutionLangGraph';

const { executeFlow, getExecutionHistory, getStateSnapshot } = 
  useWorkflowExecutionLangGraph(nodes, edges, setNodes);
```

### 2. Execute Workflow
```typescript
const handleRun = async () => {
  const result = await executeFlow();
  const history = getExecutionHistory();
  const snapshot = getStateSnapshot();
};
```

### 3. View State
```typescript
{langGraphState && (
  <div>
    <p>Run ID: {langGraphState.metadata.runId}</p>
    <p>Status: {langGraphState.metadata.status}</p>
    <p>History: {langGraphState.history.length} steps</p>
  </div>
)}
```

## 💾 Checkpointing

```typescript
import { workflowCheckpointManager } from '@features/workflow/services/checkpointManager';

// Execute with checkpoints
const result = await workflowCheckpointManager.executeWithCheckpoints(
  nodes, edges, initialState, prompt, threadId
);

// Resume later
const finalState = await workflowCheckpointManager.resumeFromCheckpoint(
  nodes, edges, threadId
);

// Export
const data = await workflowCheckpointManager.exportCheckpoint(threadId);

// Import
await workflowCheckpointManager.importCheckpoint(newThreadId, data);
```

## 👤 Human-in-the-Loop

```typescript
import { humanInTheLoopWorkflow } from '@features/workflow/services/checkpointManager';

// Request approval
const result = await humanInTheLoopWorkflow.requestApproval(
  'approval-123', 'node-id', state, 60000
);

// Check pending
const pending = humanInTheLoopWorkflow.getPendingApprovals();

// Approve
humanInTheLoopWorkflow.approve('approval-123', { user: 'john@example.com' });

// Reject
humanInTheLoopWorkflow.reject('approval-123');
```

## 🎯 State Contract

Nodes use `stateContract` to declare inputs/outputs:

```typescript
{
  stateContract: {
    inputKeys: ['user_input', 'previous_result'],  // What this node reads
    outputKeys: ['analysis', 'recommendations'],    // What this node writes
    reducer: 'overwrite'  // 'overwrite' | 'append' | 'merge'
  }
}
```

## 🔄 Reducers

### Overwrite (default)
```typescript
state.data.key = newValue  // Replaces
```

### Append
```typescript
state.data.key = [...existing, newValue]  // Adds to array
```

### Merge
```typescript
state.data.key = { ...existing, ...newValue }  // Merges objects
```

## 📊 Accessing State

### Full State
```typescript
const snapshot = getStateSnapshot();
// { data, metadata, history, logs }
```

### Execution History
```typescript
const history = getExecutionHistory();
// [{ nodeLabel, nodeId, outputKeys, output, timestamp }, ...]
```

### Graph State (original format)
```typescript
console.log(graphState);
// { ...data, __metadata: { runId, status, ... } }
```

## 🧪 Demo Component

```typescript
import { LangGraphDemo } from '@features/workflow/components/LangGraphDemo';

<LangGraphDemo nodes={nodes} edges={edges} setNodes={setNodes} />
```

Features:
- Basic execution
- Checkpointing
- Resume
- Import/Export
- Human approvals
- State viewer

## 🐛 Debugging

```typescript
// Log full state
console.log('[State]', getStateSnapshot());

// Log execution trail
console.log('[History]', getExecutionHistory());

// Log specific node output
const history = getExecutionHistory();
const nodeOutput = history.find(h => h.nodeLabel === 'My Node');
console.log('[Output]', nodeOutput);
```

## ⚡ API Comparison

| Old API | New API |
|---------|---------|
| `executeFlow()` | `executeFlow()` (same) |
| `executionLogs` | `executionLogs` (same) |
| `graphState` | `graphState` (same) |
| ❌ N/A | `langGraphState` (NEW) |
| ❌ N/A | `getExecutionHistory()` (NEW) |
| ❌ N/A | `getStateSnapshot()` (NEW) |

## 📦 Files Created

1. `src/features/workflow/services/langgraphExecutor.ts` - Core executor
2. `src/features/workflow/hooks/useWorkflowExecutionLangGraph.ts` - React hook
3. `src/features/workflow/services/checkpointManager.ts` - Persistence
4. `src/features/workflow/components/LangGraphDemo.tsx` - Demo UI
5. `LANGGRAPH_GUIDE.md` - Full guide
6. `LANGGRAPH_INTEGRATION.md` - Summary

## ✅ Status

- ✅ TypeScript: No errors
- ✅ Dependencies: Installed (@langchain/langgraph, @langchain/core)
- ✅ Backward compatible: Old hook still works
- ✅ Tests: Ready to run
- ✅ Docs: Complete

## 🎓 Learn More

- Read `LANGGRAPH_GUIDE.md` for detailed examples
- Check `LANGGRAPH_INTEGRATION.md` for migration guide
- Try `LangGraphDemo` component for interactive demo
- Visit [LangGraph docs](https://langchain-ai.github.io/langgraphjs/)
