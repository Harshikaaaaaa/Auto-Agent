# AutoAgent — Managed State Graph Requirements

## Vision

Transform AutoAgent from a **linear pipeline** (each node passes a string to the next) into a **managed state graph** — a shared, typed state object flows through the graph, and every node reads from and writes to specific keys in that state. This is the architecture used by frameworks like LangGraph.

---

## 1. Shared Graph State

### 1.1 Typed State Schema

Every workflow defines a **state schema** up-front. All nodes read from and write to this single object.

```typescript
interface GraphState {
  [key: string]: any;          // dynamic keys per workflow
  __metadata: {
    runId: string;
    startedAt: string;
    currentNodeId: string | null;
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
    error?: string;
  };
}
```

### 1.2 State Annotations

Each node declares which state keys it **reads** and which it **writes**, enabling:
- Compile-time validation (TypeScript) that all required keys exist before a node runs.
- Automatic dependency inference — no manual edge wiring needed if state keys overlap.

```typescript
interface NodeStateContract {
  inputKeys: string[];     // keys this node reads from state
  outputKeys: string[];    // keys this node writes to state
  reducer?: 'overwrite' | 'append' | 'merge';  // how writes combine with existing values
}
```

### 1.3 Reducers

When multiple nodes write to the same state key (e.g. fan-in from parallel branches), a **reducer** defines how values combine:

| Reducer     | Behaviour                                     |
|-------------|-----------------------------------------------|
| `overwrite` | Last write wins (default)                     |
| `append`    | Values are pushed to an array                 |
| `merge`     | Deep-merge objects                            |

---

## 2. Conditional Edges & Routing

### 2.1 Conditional Edges

Edges can carry a **condition function** that inspects the current state and decides whether to follow that path.

```typescript
interface ConditionalEdge {
  id: string;
  source: string;
  target: string;
  condition?: (state: GraphState) => boolean;   // evaluated at runtime
  label?: string;                                // human-readable description
}
```

### 2.2 Router Nodes

A special node type `router` evaluates state and returns the ID(s) of the next node(s) to execute, enabling dynamic branching without hard-coded edges.

```typescript
interface RouterNode {
  type: 'router';
  routingFn: (state: GraphState) => string | string[];  // returns next node ID(s)
}
```

---

## 3. Execution Engine

### 3.1 Topological Execution with State

Replace the current string-passing BFS with a state-aware executor:

1. Initialize `GraphState` with input data and metadata.
2. Topologically sort nodes (Kahn's algorithm — already implemented).
3. For each node:
   - **Read**: Extract the node's `inputKeys` from state → pass as context.
   - **Execute**: Run the node (AI call, function call, etc.).
   - **Write**: Merge the node's output into the state using the declared `outputKeys` and `reducer`.
4. Evaluate outgoing conditional edges to determine the next node(s).
5. Repeat until no more nodes are enqueued or a terminal node is reached.

### 3.2 Parallel Execution

Nodes at the same topological level with **no shared write keys** can execute concurrently via `Promise.all`.

### 3.3 Cycles & Loops

Support controlled cycles for iterative workflows (e.g. "retry until quality score > 0.8"):
- A `loop` edge type that re-enqueues a node.
- A **max iterations** guard to prevent infinite loops.
- Cycle detection at compile time with an opt-in override.

---

## 4. Checkpointing & Persistence

### 4.1 State Snapshots

After each node completes, persist a snapshot of the full `GraphState` to enable:
- **Resume**: Continue a halted workflow from the last checkpoint.
- **Replay**: Re-execute from any checkpoint for debugging.
- **Time-travel**: Inspect the state at any point in the execution history.

```typescript
interface Checkpoint {
  runId: string;
  nodeId: string;
  timestamp: string;
  state: GraphState;
  index: number;        // sequential checkpoint number
}
```

### 4.2 Storage Backend

Abstract behind an interface so it can be swapped:

| Backend        | Use Case                |
|----------------|-------------------------|
| `InMemoryStore`| Dev / testing           |
| `LocalStorage` | Browser persistence     |
| `IndexedDB`    | Large state objects     |

---

## 5. Human-in-the-Loop

### 5.1 Breakpoints

Mark specific nodes as **breakpoints**. Execution pauses before (or after) the node, and the UI surfaces the current state for human review.

### 5.2 State Editing

While paused, the user can:
- **Inspect** the full `GraphState`.
- **Edit** specific keys (e.g. fix a malformed email before the "Send Email" node).
- **Approve / Reject** to continue or abort.

### 5.3 Approval Gates

A special node type `approval_gate` that halts execution until the user explicitly approves.

---

## 6. Observability

### 6.1 Enhanced Execution Monitor

Upgrade `ExecutionMonitor.tsx` to show:
- The full `GraphState` as a collapsible JSON tree (not just string logs).
- **Diffs** — what each node changed in the state (highlighted adds/removes).
- Execution timeline with duration per node.

### 6.2 Node-Level Metrics

Track per-node:
- Execution duration (ms).
- Token usage (from Gemini responses).
- Input/output sizes.

---

## 7. Graph Compilation & Validation

### 7.1 Compile Step

Before execution, **compile** the graph:
1. Validate all edges reference existing node IDs.
2. Verify every node's `inputKeys` are satisfied by upstream `outputKeys`.
3. Detect unintended cycles.
4. Warn on unreachable nodes.

### 7.2 Type-Safe Graph Builder API

Expose a programmatic API alongside the visual editor:

```typescript
const graph = new StateGraph<MyState>()
  .addNode('parse',    parseCSVNode,    { inputKeys: ['rawCSV'], outputKeys: ['rows'] })
  .addNode('analyze',  analyzeNode,     { inputKeys: ['rows'],   outputKeys: ['stats'] })
  .addNode('report',   reportNode,      { inputKeys: ['stats'],  outputKeys: ['report'] })
  .addEdge('parse', 'analyze')
  .addEdge('analyze', 'report')
  .addConditionalEdge('analyze', (state) => state.stats.anomalies > 0 ? 'alert' : 'report')
  .compile();
```

---

## 8. AI Integration Upgrades

### 8.1 State-Aware Prompts

`executeNodeAction` receives the full state (filtered to `inputKeys`) and returns a structured object that is merged into state — not a raw string.

### 8.2 AI-Generated State Schema

When `generateWorkflow` creates a graph from a prompt, it should also generate:
- The `GraphState` schema (keys and types).
- The `NodeStateContract` for each node.
- Conditional edge conditions where applicable.

---

## 9. Updated Type Definitions

```typescript
// --- State ---
interface GraphState {
  [key: string]: any;
  __metadata: GraphMetadata;
}

interface GraphMetadata {
  runId: string;
  startedAt: string;
  currentNodeId: string | null;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  error?: string;
  checkpoints: Checkpoint[];
}

// --- Nodes ---
interface StateNodeData extends NodeData {
  stateContract: NodeStateContract;
  breakpoint?: 'before' | 'after' | 'both';
  maxRetries?: number;
}

interface NodeStateContract {
  inputKeys: string[];
  outputKeys: string[];
  reducer?: 'overwrite' | 'append' | 'merge';
}

// --- Edges ---
interface StateEdge extends WorkflowEdge {
  type: 'default' | 'conditional' | 'loop';
  condition?: string;           // serialized condition for storage
  maxIterations?: number;       // for loop edges
}

// --- Execution ---
interface StateGraphExecution {
  runId: string;
  graph: Workflow;
  state: GraphState;
  checkpoints: Checkpoint[];
  execute: () => Promise<GraphState>;
  pause: () => void;
  resume: () => void;
  getStateAt: (checkpointIndex: number) => GraphState;
}
```

---

## 10. Migration Path from Current Architecture

| Current                          | Managed State Graph                         |
|----------------------------------|---------------------------------------------|
| `nodeOutputs: Map<string, string>` | `GraphState` object with typed keys        |
| String passed between nodes      | Structured objects via `inputKeys`/`outputKeys` |
| All edges are unconditional      | Conditional + loop edges                    |
| No persistence                   | Checkpointed after every node               |
| No pause/resume                  | Breakpoints + approval gates                |
| Logs are flat strings            | State diffs + JSON tree viewer              |
| No validation before run         | Compile step verifies key flow + cycles     |

---

## Priority Order

1. **P0** — Shared `GraphState` + `NodeStateContract` + state-aware executor
2. **P0** — Conditional edges
3. **P1** — Checkpointing (in-memory first)
4. **P1** — Graph compilation & validation
5. **P2** — Human-in-the-loop (breakpoints, state editing)
6. **P2** — Parallel execution
7. **P3** — Observability upgrades (diffs, timeline)
8. **P3** — Cycles & loops
9. **P3** — Type-safe graph builder API
