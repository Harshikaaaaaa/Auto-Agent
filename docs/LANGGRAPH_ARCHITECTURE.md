# LangGraph Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AutoAgent Application                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ├── React Components
                           │   ├── WorkflowCanvas.tsx
                           │   ├── WorkflowNode.tsx
                           │   └── LangGraphDemo.tsx (NEW)
                           │
                           ├── React Hooks
                           │   ├── useWorkflowExecution.ts (Legacy)
                           │   └── useWorkflowExecutionLangGraph.ts (NEW)
                           │
                           ├── Services
                           │   ├── geminiService.ts (AI Processing)
                           │   ├── langgraphExecutor.ts (NEW - Graph Execution)
                           │   └── checkpointManager.ts (NEW - Persistence)
                           │
                           └── External Dependencies
                               ├── @langchain/langgraph
                               └── @langchain/core
```

## Data Flow

### Before (Custom Implementation)

```
User clicks "Run" → useWorkflowExecution
                           │
                           ├── Manual topological sort
                           ├── For each node in order:
                           │   ├── Extract input from state
                           │   ├── Execute node (AI or Tool)
                           │   ├── Merge output to state
                           │   └── Update UI
                           │
                           └── Return final state

❌ No checkpointing
❌ No resume capability
❌ Limited memory across nodes
```

### After (LangGraph)

```
User clicks "Run" → useWorkflowExecutionLangGraph
                           │
                    [LangGraph Executor]
                           │
                           ├── Build StateGraph
                           │   ├── Add nodes with typed state
                           │   ├── Add edges (data flow)
                           │   └── Set entry/exit points
                           │
                           ├── Compile graph with checkpointer
                           │
                           ├── Stream execution
                           │   ├── For each node:
                           │   │   ├── Pass full state + history
                           │   │   ├── Execute with context awareness
                           │   │   ├── Apply reducer strategy
                           │   │   ├── Save checkpoint
                           │   │   └── Emit update event
                           │   │
                           │   └── Callbacks:
                           │       ├── onNodeUpdate (UI)
                           │       ├── onStateUpdate (State)
                           │       └── onLogUpdate (Logs)
                           │
                           └── Return complete state with history

✅ Automatic checkpointing
✅ Resume from any point
✅ Full execution history
✅ Rich context for AI nodes
```

## State Structure

### WorkflowStateType

```typescript
{
  data: {                          // Your workflow data
    user_input: "...",
    analysis: "...",
    recommendations: [...],
    // ... any dynamic keys
  },

  metadata: {                      // Execution metadata
    runId: "uuid",
    startedAt: "2024-02-16T...",
    currentNodeId: "node-123" | null,
    status: "running" | "completed" | "failed" | "paused",
    error?: "error message"
  },

  history: [                       // Execution trail
    {
      nodeLabel: "Analyze Input",
      nodeId: "node-1",
      outputKeys: ["analysis"],
      output: { analysis: "..." },
      timestamp: "2024-02-16T..."
    },
    // ... more entries
  ],

  logs: [                          // UI logs
    {
      node: "Analyze Input",
      time: "10:30:45 AM",
      output: "{ analysis: ... }",
      stateSnapshot: { ... }
    },
    // ... more logs
  ],

  originalPrompt: "Analyze customer feedback and send summary"
}
```

## Node Execution Flow

```
┌──────────────────────────────────────────────────────────┐
│                   LangGraph Node                         │
│                                                          │
│  1. Receive State                                        │
│     ├── data: All accumulated workflow data              │
│     ├── history: What previous nodes produced            │
│     └── originalPrompt: User's request                   │
│                                                          │
│  2. Extract Input                                        │
│     └── Based on stateContract.inputKeys                 │
│                                                          │
│  3. Execute Node Logic                                   │
│     ├── Tool Node → Call external API                    │
│     ├── AI Agent → Process with Gemini + context         │
│     ├── Trigger → Initialize with seed data              │
│     └── Passthrough → Pass data through                  │
│                                                          │
│  4. Apply Reducer                                        │
│     ├── Overwrite: Replace values                        │
│     ├── Append: Add to arrays                            │
│     └── Merge: Deep merge objects                        │
│                                                          │
│  5. Update State                                         │
│     ├── Merge output into data                           │
│     ├── Add to history                                   │
│     ├── Append to logs                                   │
│     └── Update metadata                                  │
│                                                          │
│  6. Save Checkpoint (automatic)                          │
│                                                          │
│  7. Emit Events                                          │
│     ├── onNodeUpdate → UI updates                        │
│     ├── onStateUpdate → State changes                    │
│     └── onLogUpdate → Log streaming                      │
└──────────────────────────────────────────────────────────┘
```

## Checkpoint System

```
Thread ID: "workflow-abc-123"
    │
    ├── Checkpoint 1: After node "Trigger"
    │   └── State: { data: { user_input: "..." }, ... }
    │
    ├── Checkpoint 2: After node "Analyze"
    │   └── State: { data: { user_input: "...", analysis: "..." }, ... }
    │
    ├── Checkpoint 3: After node "Generate Email"
    │   └── State: { data: { ..., email_content: "..." }, ... }
    │
    └── Checkpoint 4: After node "Send Email"
        └── State: { data: { ..., email_status: "sent" }, ... }

Operations:
  - Resume: Start from any checkpoint
  - Export: Save to JSON file
  - Import: Load from JSON file
  - History: View all checkpoints
  - Clear: Remove all checkpoints
```

## Human-in-the-Loop

```
Workflow Execution
    │
    ├── Node 1 (Trigger) → Execute
    │
    ├── Node 2 (AI Analysis) → Execute
    │
    ├── Node 3 (Draft Email) → Execute
    │
    ├── Node 4 (Review Required)
    │   └── PAUSE ⏸️
    │       └── Request Approval
    │           │
    │           ├── Show in UI
    │           ├── Wait for user action
    │           │
    │           └── User Decides:
    │               ├── Approve ✅ → Continue with data
    │               └── Reject ❌ → Fail workflow
    │
    └── Node 5 (Send Email) → Execute (if approved)
```

## Integration Points

### 1. WorkflowCanvas Component
```typescript
// Option A: Use old hook (still works)
import { useWorkflowExecution } from '...';

// Option B: Use new hook (enhanced)
import { useWorkflowExecutionLangGraph } from '...';

// Both have same basic API, new one adds:
// - getExecutionHistory()
// - getStateSnapshot()
// - langGraphState
```

### 2. Gemini AI Service
```typescript
// AI nodes receive WorkflowContextBuffer
{
  originalPrompt: string,        // User's request
  fullGraphState: {...},         // All data so far
  executionHistory: [...]        // What nodes produced
}

// AI uses this for:
// - Better context awareness
// - Consistent with earlier decisions
// - Using exact values from state
```

### 3. Tool Registry
```typescript
// Tool nodes execute directly
const tool = getTool(toolId);
const action = tool.actions.find(a => a.name === toolAction);
const output = await action.execute(inputState);

// LangGraph handles:
// - State merging
// - Error handling
// - Checkpointing
```

## File Organization

```
src/features/workflow/
  ├── components/
  │   ├── WorkflowCanvas.tsx
  │   ├── WorkflowNode.tsx
  │   └── LangGraphDemo.tsx        ← NEW: Interactive demo
  │
  ├── hooks/
  │   ├── useWorkflowExecution.ts  ← Legacy (still works)
  │   └── useWorkflowExecutionLangGraph.ts  ← NEW: Enhanced
  │
  ├── services/
  │   ├── langgraphExecutor.ts     ← NEW: Core executor
  │   └── checkpointManager.ts     ← NEW: Persistence
  │
  └── types.ts

Docs:
  ├── LANGGRAPH_GUIDE.md           ← Full guide
  ├── LANGGRAPH_INTEGRATION.md     ← Summary
  └── LANGGRAPH_QUICKREF.md        ← Quick reference
```

## Key Benefits

### 1. Memory & Context
- Each node sees complete execution history
- AI agents reference earlier decisions
- Consistent state across workflow

### 2. Persistence
- Save workflow state at any point
- Resume from interruptions
- Import/export for sharing

### 3. Debugging
- Time-travel through execution
- Inspect state at each step
- Full execution trail

### 4. Error Recovery
- Automatic checkpointing
- Resume from failure point
- Better error propagation

### 5. Human Involvement
- Pause for approvals
- Inject decisions
- Override AI outputs

### 6. Scalability
- Built on production framework
- Type-safe state management
- Optimized graph execution
