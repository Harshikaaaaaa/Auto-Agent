# AI Workflow Orchestration Product Brief

## Product vision

Build a stable AI workflow orchestration platform that turns user prompts into structured automation flows, reuses built-in tool capabilities, and executes them deterministically with visible state, auth handling, and routing.

The product should feel like a modern workflow builder, but it must remain reliable, bounded, and explainable. It is not a free-form autonomous agent runtime. It is a prompt-to-workflow system with reusable tool orchestration.

---

## Current state of the project

The project already has a solid foundation:

- workflow canvas with node editing
- trigger-first blank workflow behavior
- reusable node suggestion flow
- AI prompt-driven planning
- tool registry and connector system
- workflow execution engine with shared state
- auth validation and reconnect flow
- save/load workflow support
- connector support for Gmail, Google Sheets, Google Drive, Slack, and WhatsApp

This means the app is already structurally close to a real workflow-builder product. The core foundation is there.

---

## BuildMyAgent-like prompt-to-creation features

The product should include the key user experience patterns that make a BuildMyAgent-style AI builder feel powerful and usable:

### 1. Natural-language workflow creation
- user enters a goal in plain English such as "Create a lead qualification workflow with Gmail, Sheets, and Slack"
- the system extracts the objective, trigger, required actions, and data flow
- the workflow is converted into a structured graph instead of a vague agent instruction

### 2. Smart requirement parsing
- identify triggers, data sources, outputs, conditions, and external tools
- detect whether the user needs email, spreadsheet, CRM, messaging, file, or retrieval actions
- classify workflows by use case such as support, sales, research, operations, reporting, onboarding, or content generation

### 3. Prompt-to-plan generation
- generate a workflow plan before execution
- present the plan as a preview with editable steps
- let the user approve, modify, or regenerate the plan
- convert the approved plan into actual canvas nodes automatically

### 4. Automatic tool discovery and node selection
- detect required capabilities from the prompt
- match them to built-in reusable nodes and connectors
- recommend or auto-import relevant reusable tools instead of creating duplicate custom nodes
- avoid reinventing basic actions when standard workflow blocks already exist

### 5. Reusable workflow blocks and agent-like capabilities
- predefine common blocks such as summarize, classify, route, extract data, send email, append row, create document, notify Slack, and update sheets
- allow these blocks to be reused across workflows
- give users the ability to create custom blocks from successful flows

### 6. Prompt-based editing and refinement
- after generation, the user can ask for changes such as "add approval step", "use Gmail instead of Slack", or "send summary to a Google Sheet"
- the planner updates the graph without needing manual node rebuilding
- revisions remain grounded in the existing workflow state

### 7. Multi-step workflow assembly from a single request
- the user can describe an end-to-end task in one prompt
- the system expands it into a complete chain of steps
- each step maps to a proper workflow node or reusable component
- the system keeps the chain explainable and editable

### 8. Tool and connector onboarding inside the flow
- when a workflow requires Gmail, Sheets, Drive, Slack, or WhatsApp, the system checks auth status
- if disconnected, it prompts the user to reconnect before running
- once enabled, the tool becomes reusable in future workflows

### 9. Workflow templates and saved patterns
- save completed prompt-generated flows as reusable templates
- support versioning and duplication of successful scenarios
- turn common patterns into standard workflow recipes

### 10. AI-assisted flow review and guardrails
- show generated workflow summary before execution
- highlight required connectors, data dependencies, and decision points
- allow user to approve or reject generated steps
- reduce risk of random autonomous behavior

### 11. Human-in-the-loop review model
- critical workflows can pause for review before sending an email, posting a message, or updating data
- approvals can be inserted as workflow nodes
- users keep control over actions that affect external systems

### 12. Prompt-to-production workflow lifecycle
- prompt creates workflow
- planner builds graph
- user adjusts and approves
- runtime executes deterministically
- workflow can be saved, reused, modified, and reused later

This is the key BuildMyAgent-like value: a user describes a goal, the system builds the workflow architecture, and the user refines the generated flow before execution.

---

## Core product direction

We should build:

1. Workflow-first UX
   - start with a trigger node
   - graph-based flow building
   - connect reusable blocks visually
   - clear node categories

2. AI-assisted planning
   - user describes a scenario in plain language
   - AI proposes a structured workflow plan
   - user reviews and approves the plan
   - planner creates nodes in the canvas

3. Reusable built-in tools as default
   - Gmail, Sheets, Drive, Slack, WhatsApp, logic branches, summaries, etc.
   - prefer built-in reusable functions over new custom nodes
   - reduce duplication and increase stability

4. Deterministic execution engine
   - graph runs in ordered steps
   - shared state passes between nodes
   - tool calls are explicit and trackable
   - no open-ended autonomous loops by default

5. Capability-aware routing
   - match intent to a compatible tool or capability
   - rank best provider/tool for a task
   - support fallback options when a tool fails
   - keep routing transparent and bounded

6. Auth-aware, failure-safe runtime
   - validate tool auth before execution
   - show reconnect prompts when auth expires
   - retry or fallback when a provider fails
   - log execution state clearly

---

## What we should avoid

We should not build a product centered on:

- free-running autonomous agents
- chaotic prompt-based execution loops
- custom LangChain code generated from every prompt
- ad hoc tool creation with no reuse
- fragile runtime behavior without guardrails

These approaches make the system unpredictable and hard to trust.

---

## Recommended architecture

### 1. Planner layer
Transforms user input into a structured workflow plan.

Output includes:

- workflow title
- trigger
- ordered steps
- node types
- tool IDs and actions
- inputs and outputs
- required auth or connectors
- conditional branches

### 2. Capability router
Matches workflow needs to available tool capabilities.

Each tool/capability should have metadata like:

- capability type
- tool/provider name
- input schema
- output schema
- auth requirement
- reliability or quality score
- cost / latency profile
- fallback options

### 3. Reusable node registry
Stores all built-in workflow blocks.

Examples:

- Email Send
- Spreadsheet Append
- Drive Upload
- Slack Message
- WhatsApp Send
- Conditional Branch
- Set Variable
- Summary Output
- MCP Tool
- Retrieval / RAG step
- Memory step

### 4. Workflow graph runtime
Executes nodes in a deterministic graph.

This layer handles:

- node ordering
- shared state
- edge flow
- branch decisions
- output collection
- tool invocation and error handling

### 5. Mature LangGraph-style runtime features
This is the production-grade execution layer required for a reliable orchestration platform.

The runtime should support:

- advanced loop control for iterative workflow patterns
- human-in-the-loop interrupt points before risky or irreversible actions
- orchestration branching complexity for multi-path decision trees
- long-running workflow states with resumable execution
- idempotent retry policies to avoid duplicate side effects
- full production orchestration controls such as pause, resume, cancel, re-run, and checkpoint recovery
- deterministic state snapshots for auditing and debugging
- retry/fallback logic across provider and tool failure modes
- tool execution guards to prevent unbounded or repeated actions

This is where the product moves beyond basic node execution into a production-ready workflow engine. It should provide the same reliability expectations seen in advanced orchestration frameworks, without becoming free-form autonomous behavior.

### 6. Observability and recovery layer
Ensures the product is stable in real use.

Includes:

- execution logs
- node status
- state viewer
- auth reconnect UI
- retry/fallback handling
- tool health and failure visibility

---

## Multi-level AI workflow model

The system should support agent-like behavior only inside a structured workflow, not as a free autonomous engine.

Example scenario structure:

- Trigger
- Understand request
- Gather context / retrieve data
- Select relevant tool(s)
- Execute action(s)
- Validate result
- Branch based on outcome
- Summarize or send result

This is effectively an agent pattern, but designed as workflow steps instead of a runaway loop.

---

## How MCP, RAG, and memory fit

These should be added as workflow components, not as a separate chaotic runtime layer.

Examples:

- MCP tool node for external tool access
- Retrieval node for vector search / document lookup
- Memory node for persisted conversation or context
- Decision node for branching logic
- Output node for final response or summary

This keeps the system explainable and predictable.

---

## Recommended milestone plan

### Phase 1: Stabilize the workflow builder
- finalize trigger-first blank flow
- standardize node categories
- improve reusable node selection
- improve graph clarity and connection behavior
- keep auth and execution failures visible

### Phase 2: Strengthen planning and generation
- prompt-to-plan preview flow
- structured workflow schema generation
- prefer built-in reusable nodes before custom ones
- create graph from approved plan

### Phase 3: Add capability routing
- metadata for tools and capabilities
- prompt-to-capability matching
- preferred tool selection
- fallback logic and performance-based routing

### Phase 4: Add AI workflow components
- MCP-based tool nodes
- retrieval / RAG nodes
- memory nodes
- validation and branch nodes
- format and summary outputs

### Phase 5: Make it production-grade
- workflow validation before run
- retry logic and failure recovery
- execution history and observability
- better auth recovery UX
- usage tracking and provider benchmarking

---

## Product positioning

The product should be positioned as:

"AI workflow orchestration platform that turns prompts into structured automation flows, reuses built-in capabilities, and executes them deterministically with clear state and auth-aware reliability."

This is more differentiated and more stable than simply calling it an AI agent platform or a generic automation builder.

---

## Final recommendation

The right path is to build:

- AI-assisted workflow building
- reusable tool-first architecture
- deterministic graph execution
- capability-based routing
- stable runtime and auth behavior

This is the best product direction for a reliable, scalable, and differentiated workflow automation product.
