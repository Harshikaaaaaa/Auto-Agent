# AI Workflow Builder Product Brief

## Product direction

Build an AI-assisted workflow builder that feels like n8n, but remains stable, deterministic, and tool-first.

The product should not behave like an open-ended autonomous agent engine. Instead, it should behave like:

- a workflow canvas first
- AI as planning and orchestration assistance
- reusable built-in tool nodes as the default
- deterministic graph execution
- tool capability routing for reliability and scale

---

## Core findings so far

### 1. The app already has a strong foundation
The current codebase already includes:

- workflow canvas UI
- trigger-first blank workflow behavior
- reusable node suggestions
- trigger-to-tool graph flow
- AI prompt planning
- graph execution engine
- auth validation and reconnect behavior
- save/load workflow support
- connector registry for Gmail, Sheets, Drive, Slack, and WhatsApp

This means the project is already structurally close to an n8n-like workflow builder.

### 2. The wrong direction to avoid
We should avoid building a free-running autonomous agent engine as the main product model.

This creates risks such as:

- runaway loop behavior
- unclear tool choice
- unstable execution
- unpredictable workflow creation
- difficult debugging and user trust issues

### 3. The stable long-term model is workflow-first
The right model is:

- user enters a prompt
- AI creates a structured workflow plan
- workflow is built as graph nodes
- reusable built-in nodes are preferred
- graph runs deterministically with shared state
- failure and auth states are handled explicitly

### 4. Reusable tool nodes must be the default path
We should strongly prefer built-in nodes such as:

- Gmail
- Google Sheets
- Google Drive
- Slack
- WhatsApp
- logic nodes
- branch nodes
- summary/output nodes

This is consistent with both n8n and MCP-style capability discovery.

### 5. Capability routing is the next smart layer
The next major feature after workflow stability is a capability router that decides:

- what capability is needed
- which tool or provider is best for it
- which fallback to use if it fails
- what provider or action should be selected based on performance and cost

This is the “Agentmuxer”-style idea, but adapted to a stable workflow builder instead of an autonomous runtime.

---

## Product vision

Build an AI workflow canvas where users can:

1. start with a trigger
2. choose or auto-generate reusable nodes
3. let AI propose a structured workflow plan
4. approve or refine the plan
5. run the workflow with visible state and logs
6. reconnect or retry when tools require authentication

The product should feel like n8n, but with AI planning and smart tool selection layered on top.

---

## Recommended architecture

### A. Planner layer
Responsible for turning a natural-language prompt into a structured workflow plan.

Required output:

- workflow title
- workflow goal
- trigger definition
- ordered steps
- node types
- tool IDs / action IDs
- input and output contracts
- branch conditions
- required auth or connector dependencies

### B. Capability router layer
Responsible for matching the workflow intent to the best available tool or capability.

This layer should maintain metadata such as:

- capability type
- tool/provider
- input schema
- output schema
- auth requirements
- reliability metrics
- latency and cost
- fallback options

### C. Workflow graph layer
Responsible for actual execution.

Node categories should include:

- trigger
- planner/orchestrator
- tool/action
- decision/branch
- sub-step / specialist step
- output/summary
- memory/retrieval (later phase)

### D. Execution + observability layer
Responsible for stable runtime behavior.

This includes:

- shared graph state
- node order execution
- logs and debugging
- auth checks before run
- reconnect flow for expired credentials
- retry and fallback handling

---

## Recommended product lifecycle

### Phase 1: Build the stable workflow base
- trigger-first blank canvas
- drag-to-connect nodes
- reusable node library
- simple graph execution
- visible logs and state
- auth validation

### Phase 2: Add AI-assisted planning
- prompt input creates a workflow plan preview
- user approves or edits the plan
- plan converts into nodes on the canvas
- node generation prefers reusable built-in actions

### Phase 3: Add capability routing
- map prompt/task to tool capabilities
- rank tool/provider candidates
- auto-pick the best built-in or external tool
- support fallback when a provider fails

### Phase 4: Add advanced workflow patterns
- condition branches
- loops / retries
- summary outputs
- human-in-the-loop steps
- memory-aware specialist steps

### Phase 5: Add marketplace / MCP integration
- registry-based external tools
- provider marketplace access
- usage reporting and provider benchmarking
- billing and one-balance systems later

---

## Product principle

The product should be:

- workflow-first
- tool-driven
- deterministic
- explainable
- AI-assisted
- reliable under auth and runtime failure

Not:

- free-form autonomous agent-first
- chaotic runtime behavior
- duplicate custom tool generation by default

---

## Success criteria

The product should be considered successful when:

1. a user can start with a trigger and build a workflow visually
2. the AI can propose a structured workflow from a prompt
3. reusable built-in nodes are selected before custom duplicates
4. the app can run workflow graphs deterministically
5. auth failures are surfaced clearly and recoverable
6. tool selection becomes smarter over time through capability routing
7. the app feels like an n8n-style workflow builder, not just a chat assistant

---

## Recommended immediate next move

Implement in this order:

1. fix and standardize node taxonomy
2. improve planner schema output
3. push built-in reusable node selection before custom node generation
4. add capability metadata to the tool registry
5. add smarter routing and fallback logic
6. keep execution deterministic and visible

---

## Short product statement

AI workflow builder with n8n-like UX, deterministic execution, reusable built-in tools, and capability-based routing for stable automation.
