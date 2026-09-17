# AutoAgent — Feature Development Plan

**Product Vision:** harAI — a text-to-everything automation platform that combines n8n-style workflow automation, full-stack app generation, and multi-model AI orchestration.

**Last Updated:** February 16, 2026

---

## ✅ What's Built So Far

### 1. Feature-Based Architecture — `COMPLETE`
- Modular `src/` structure: `app/`, `features/`, `shared/`, `config/`, `assets/`
- Path aliases (`@/`, `@features/`, `@shared/`, `@config/`) configured in Vite & TypeScript
- Clean separation of concerns across domains

### 2. Visual Workflow Canvas — `COMPLETE`
- [WorkflowCanvas.tsx](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/components/WorkflowCanvas.tsx) — main canvas with ReactFlow integration
- [WorkflowNode.tsx](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/components/WorkflowNode.tsx) — dynamic node rendering with 1000+ Lucide icons, skill-based colors, capability badges, status indicators
- Three visual node styles: AI Agent (large), Skill Node (compact), Tool (icon-only)
- Zoom, pan, drag-and-drop, mini-map, node inspector panel

### 3. Skill & Tool System — `COMPLETE`
**20+ specialized skills** across 7 categories:

| Category | Skills |
|---|---|
| Data | CSV Parser, JSON Transformer, Data Validator, Data Analyzer |
| Communication | Email Sender, Slack Notifier, SMS Sender |
| AI | Text Analyzer, Content Generator |
| Documents | PDF Generator, Report Builder, Spreadsheet Creator |
| Analysis | Data Analyzer, Sentiment Analyzer |
| Automation | Scheduler, Webhook Handler |
| Integration | API Caller, Database Connector |

- Tool registry with dynamic registration ([toolRegistry.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/tools/toolRegistry.ts))
- Connector framework with Gmail as first implementation ([gmail.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/tools/connectors/gmail.ts))

### 4. Executable Functions — `COMPLETE`
9 real TypeScript functions that perform actual operations:
1. `parse_csv` — CSV parsing with delimiter support
2. `transform_json` — JSONPath-based transformations
3. `validate_data` — schema validation with type checking
4. `analyze_data` — statistical calculations (mean, median, stddev)
5. `analyze_text` — sentiment analysis + keyword extraction
6. `generate_content` — template variable substitution
7. `format_email` — email validation and formatting
8. `format_slack_message` — Slack message formatting
9. `format_sms` — SMS formatting with character limits

### 5. AI Service (Gemini) — `PARTIAL`
- [geminiService.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/ai/services/geminiService.ts) — workflow generation from natural language prompts
- State-aware prompt construction with `WorkflowContextBuffer`
- `executeNodeAction()` with structured JSON output keyed by `outputKeys`
- Function calling support (implemented)

> [!CAUTION]
> **BLOCKED:** Gemini API returns 404 — model name mismatch with `@google/genai` v1beta endpoint. Workflow generation, function calling, and end-to-end execution are all non-functional until resolved.

### 6. Execution Engine — `PARTIAL`
- [langgraphExecutor.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/services/langgraphExecutor.ts) — LangGraph-based state graph executor
- [checkpointManager.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/services/checkpointManager.ts) — state snapshot persistence
- [useWorkflowExecution.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/hooks/useWorkflowExecution.ts) — React hook for execution lifecycle
- [useWorkflowExecutionLangGraph.ts](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/hooks/useWorkflowExecutionLangGraph.ts) — LangGraph-specific hook
- [LangGraphDemo.tsx](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/components/LangGraphDemo.tsx) — demo component

### 7. Execution Monitor UI — `COMPLETE`
- [ExecutionMonitor.tsx](file:///Users/dineshgaddam/Documents/Projects/auto-agent/src/features/workflow/components/ExecutionMonitor.tsx) — live logs, download output, terminal-style interface

### 8. UI/UX & Build System — `COMPLETE`
- Dark-themed, professional interface with smooth animations
- Vite build succeeds (1,766 modules, no TS/lint errors)
- Dev server running on `http://localhost:3233/`

---

## ❌ What's Yet to Be Done

Grouped by priority and aligned with the Context.md product vision.

---

### P0 — Critical Blockers / Core Foundation

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | **Fix Gemini API Integration** | Resolve the model name 404 error in `geminiService.ts`. All AI features are blocked on this. | 🔴 Blocked |
| 2 | **End-to-End Workflow Execution** | Test and validate the full cycle: prompt → workflow generation → node execution → state merging → result display. | 🔴 Untested |
| 3 | **Function Calling Validation** | Verify Gemini correctly triggers registered tool functions and processes return values. Schema fix applied but untested. | 🔴 Untested |
| 4 | **Managed State Graph (P0 from requirements.md)** | Implement shared `GraphState`, `NodeStateContract`, state-aware executor with `inputKeys`/`outputKeys` and reducers. | 🟡 Partially built |
| 5 | **Conditional Edges & Routing** | `ConditionalEdge` with runtime condition functions and `RouterNode` for dynamic branching. | 🔴 Not started |

---

### P1 — Core Platform Features

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 6 | **Checkpointing & Persistence** | State snapshots after each node for resume, replay, and time-travel debugging. `InMemoryStore` → `LocalStorage` → `IndexedDB`. | 🟡 Manager exists, needs integration |
| 7 | **Graph Compilation & Validation** | Pre-execution compile step: validate edges, verify key flow, detect cycles, warn on unreachable nodes. | 🔴 Not started |
| 8 | **Additional Service Integrations** | Context.md targets 100+ connectors (Slack, Drive, Sheets, WhatsApp, Stripe, etc.). Only Gmail connector exists. | 🔴 1 of 100+ |
| 9 | **More AI Model Support** | Currently Gemini only. Vision calls for GPT-4, Claude, DALL-E, Whisper, Stable Diffusion, HuggingFace hub. | 🔴 Not started |
| 10 | **Backend / API Server** | Context.md envisions a backend (Node.js/Python) for execution, persistence, OAuth, and deployment. Currently frontend-only. | 🔴 Not started |

---

### P2 — Workflow Engine Enhancements

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 11 | **Human-in-the-Loop** | Breakpoints, state editing while paused, approval gates. | 🔴 Not started |
| 12 | **Parallel Execution** | Concurrent node execution for independent branches via `Promise.all`. | 🔴 Not started |
| 13 | **Cycles & Loops** | Loop edge type, max iterations guard, cycle detection with opt-in override. | 🔴 Not started |
| 14 | **Type-Safe Graph Builder API** | Programmatic `StateGraph<T>().addNode().addEdge().compile()` API alongside visual editor. | 🔴 Not started |

---

### P3 — Product Vision Features (from Context.md)

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 15 | **Full-Stack App Generation** | Generate React/Next.js/React Native apps from text descriptions with auth, DB, and deployment. | 🔴 Not started |
| 16 | **Authentication Platform** | OAuth hub for one-click service connections (Gmail, Drive, Slack, etc.). | 🔴 Not started |
| 17 | **User Dashboard** | View/manage workflows, execution history, analytics. | 🔴 Not started |
| 18 | **Template Marketplace** | Pre-built workflow templates users can browse and deploy. | 🔴 Not started |
| 19 | **Deployment Engine** | Auto-deploy generated apps to Vercel/AWS/Railway. | 🔴 Not started |
| 20 | **Voice-to-Software** | Speech input → live app building. | 🔴 Not started |
| 21 | **AI Agent Marketplace** | Specialized autonomous agents (Dev, QA, DevOps, PM, etc.). | 🔴 Not started |
| 22 | **App Store Optimization** | Auto-generate app metadata, screenshots, preview videos. | 🔴 Not started |
| 23 | **Industry Vertical Factories** | Pre-built domain systems: Healthcare, E-commerce, Fintech, etc. | 🔴 Not started |
| 24 | **Competitive Intelligence** | Monitor competitor apps and auto-suggest feature additions. | 🔴 Not started |
| 25 | **Legacy Code Modernization** | Upload old codebases (COBOL, Java) → modern stack conversion. | 🔴 Not started |
| 26 | **Multi-Tenant SaaS Transformer** | Convert single-user apps into SaaS platforms. | 🔴 Not started |
| 27 | **Security & Pen Testing Suite** | Continuous OWASP scanning, auto-fixing, compliance reporting. | 🔴 Not started |
| 28 | **Global Localization** | One-click translation, currency, payment gateway, and regulation adaptation for 50+ countries. | 🔴 Not started |

---

### P3 — Observability & Quality

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 29 | **Enhanced Execution Monitor** | Full `GraphState` as collapsible JSON tree, state diffs per node, execution timeline with durations. | 🔴 Not started |
| 30 | **Node-Level Metrics** | Track execution duration, token usage, input/output sizes per node. | 🔴 Not started |
| 31 | **Billing & Monetization** | Pricing tiers (Free / Starter / Pro / Enterprise), usage tracking, Stripe integration for platform billing. | 🔴 Not started |
| 32 | **Team Collaboration** | Multi-user editing, permissions, version control for workflows. | 🔴 Not started |

---

## 📊 Current Progress Summary

```
Architecture & Code Quality     ████████████████████  100%
Skill & Tool System              ████████████████████  100%
Executable Functions             ████████████████████  100%
UI Components                    ████████████████████  100%
Execution Monitor UI             ████████████████████  100%
AI Integration (Gemini)          ██████░░░░░░░░░░░░░░   30%  ← BLOCKED
Execution Engine (LangGraph)     ████████░░░░░░░░░░░░   40%
Service Connectors               ██░░░░░░░░░░░░░░░░░░    5%  (Gmail only)
State Graph (requirements.md)    ████░░░░░░░░░░░░░░░░   20%
Backend / API Server             ░░░░░░░░░░░░░░░░░░░░    0%
Full Product Vision (Context.md) ██░░░░░░░░░░░░░░░░░░    8%
```

---

## 🎯 Recommended Next Steps

1. **Fix the Gemini API model name** — unblock all AI features immediately
2. **Validate end-to-end workflow execution** — prompt → generate → execute → display
3. **Complete managed state graph** per `requirements.md` (P0 items)
4. **Add conditional edges** for non-trivial workflow logic
5. **Build 5–10 more connectors** (Slack, Google Sheets, Stripe, WhatsApp, Twilio)
6. **Stand up a backend API** for persistence, OAuth, and execution outside the browser
