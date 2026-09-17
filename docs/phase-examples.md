# Phase Examples — Reference from Context.md

Concrete examples extracted from [Context.md](file:///Users/dineshgaddam/Documents/Projects/auto-agent/Context.md) for each implementation phase.

---

## Phase 1 — Core Engine (Conditional Edges, Save/Load, Checkpoints, MiniMap)

### Conditional Edges & Router Nodes

**Example 1 — If/Else Branching (line 556-560)**
The workflow engine spec defines these logic node types:
```
"conditional": "If/Else branches"
"loops":       "Iterate over arrays"
"transforms":  "Data mapping, filtering"
"delays":      "Wait X seconds/minutes/hours"
"error_handling": "Retry logic, fallbacks"
```

**Example 2 — Fitness Streak Condition (lines 748-767)**
A real conditional branch inside a workflow:
```
[Workout Logged]
     ↓
[Add to Google Sheets] → [Update row with stats]
     ↓
[GPT-4: Generate motivational message]
     ↓
[Send Push Notification] → [Include AI message]
     ↓
[Check streak count]
     ↓
IF streak == 7 days:
  ├─ [Generate certificate PDF]
  ├─ [Send email with certificate]
  ├─ [Create Instagram story template]
  └─ [Prompt user to share]
```
**Implementation reference:** The router node evaluates `state.streak_count === 7`, then routes to either the celebration branch or the passthrough (skip) branch.

**Example 3 — Simple Automation with Branch (lines 112-132)**
```
Typeform → Sheet Row → GPT-4 Prompt → Gmail Send
                    └→ Slack Message
```
The `└→` is a fork — the `Sheet Row` node has two unconditional outgoing edges (parallel fan-out).

**Example 4 — Node Types (lines 948-954)**
```
"Trigger nodes (webhook, schedule, database)"
"Action nodes  (API calls, database ops)"
"Logic nodes   (if/else, loops, switches)"
"Transform nodes (data mapping)"
"AI nodes      (GPT-4, Claude, image gen)"
```

---

### Workflow Save/Load

**Example — User Reviews & Modifies (lines 91-98)**
```
1. Generate workflow
2. Show visual flow diagram (n8n-style)
3. User reviews/approves        ← save here
4. Execute step-by-step
5. Report progress in real-time
6. Handle errors autonomously
7. Complete or ask for guidance
```
Users need to save after reviewing (step 3) and re-load later to re-run or modify.

**Example — Browse Templates (lines 293-296 in WorkflowCanvas)**
The "Browse Templates" button is already in the UI splash screen. Save/load enables populating this with pre-built template workflows.

---

### MiniMap

**Example — Workflow Engine Spec (line 937)**
```json
"features": [
  "Drag-and-drop nodes",
  "Connection validation",
  "Zoom/pan canvas",
  "Mini-map",          ← explicitly required
  "Node grouping"
]
```

---

## Phase 2 — UI/UX Polish (Dynamic Icons, Undo/Redo, Skeletons, Monitor Enhancements)

### Dynamic Node Icons

**Example — Per-Category Icons (lines 948-954)**
Each node type should show a distinct icon:
- **Trigger**: `Zap` (webhook), `Clock` (schedule), `Database` (DB change)
- **Action**: `Send` (API call), `HardDrive` (DB op)
- **Logic**: `GitBranch` (if/else), `Repeat` (loop), `Route` (switch)
- **Transform**: `Shuffle` (data mapping)
- **AI**: `Brain` (GPT-4), `Wand2` (image gen), `Mic` (Whisper)

### Execution Monitor Enhancements

**Example — Fitness Coaching Workflow Progress (lines 680-713)**
Each step logs its result with timing:
```
[1/15] 🧠 Analyzing requirements...     [0.4s]
[2/15] 🏗 Designing architecture...     [1.2s]
[3/15] 💾 Creating database schema...   [0.8s]
...
[8/15] 🤖 Building workflow: "Workout Complete"  [2.1s]
```
**Implementation reference:** Show `durationMs` per node in the ExecutionMonitor. Add state diff highlighting (green = new keys, yellow = changed values).

**Example — Real-Time Progress (lines 176-191)**
```
✓ Initialized Next.js project
✓ Set up database schema
✓ Created auth flow
✓ Built upload interface
✓ Integrated Whisper API
✓ Connected Claude API
✓ Added Stripe checkout
✓ Created admin dashboard
✓ Running tests... All passed!
✓ Deploying to Vercel...
```
Each line appears progressively — the execution monitor should replicate this experience.

---

## Phase 3 — Additional Connectors (Google Sheets, Google Drive, Slack)

### Connector Examples from Context.md

**Google Sheets (lines 671-675, 754)**
```
Fitness app: "When user completes workout → add stats to Google Sheets"
```
Actions needed: `read_sheet`, `write_sheet`, `append_row`

**Google Drive (line 214)**
```
"storage": ["Google Drive", "Dropbox", "OneDrive", "S3"]
```
Actions needed: `list_files`, `upload_file`, `download_file`

**Slack (lines 112-115)**
```
"When someone fills my Typeform, send the data to Google Sheets,
 create a personalized email using GPT-4, and send it via Gmail.
 Also post their info to my Slack channel."
```
Actions needed: `send_message`, `read_channel`, `list_channels`

### Full Integration List from Vision (lines 527-553)
The vision calls for these connector categories:
```
Communication:  Gmail, Outlook, Slack, Discord, WhatsApp, Telegram
CRM/Sales:      Salesforce, HubSpot, Pipedrive
Storage:        Google Drive, Dropbox, OneDrive, S3
Payments:       Stripe, Razorpay, PayPal
AI Models:      OpenAI GPT-4, Claude, Whisper, DALL-E, Stable Diffusion,
                Suno, ElevenLabs, HuggingFace (1000+ models)
Data:           Airtable, Notion, MongoDB, PostgreSQL
Marketing:      Mailchimp, SendGrid, Twilio
```

---

## Phase 4 — Advanced Engine (Parallel Execution, Breakpoints, Validation)

### Parallel Execution

**Example — Fork Pattern (lines 119-120)**
```
Typeform → Sheet Row → GPT-4 Prompt → Gmail Send
                    └→ Slack Message
```
`Sheet Row` has 2 outgoing edges: both `GPT-4 Prompt` AND `Slack Message` should execute in parallel via `Promise.all()`.

**Example — Multi-App Architecture (lines 689-712)**
```
FRONTEND APPS:
├─ Client App (React Native)
└─ Coach Dashboard (React Native + Web)

WORKFLOWS:                         ← parallel branches
├─ Workout Complete Automation
├─ 7-Day Streak Celebration
├─ Weekly Summary Email
└─ Coach Notification System
```

### Breakpoints & Human-in-the-Loop

**Example — Flow Review Loop (lines 91-97)**
```
1. Generate workflow
2. Show visual flow diagram
3. User reviews/approves     ← breakpoint before execution
4. Execute step-by-step
5. Report progress
6. Handle errors
7. Complete or ask for guidance  ← breakpoint on error
```

**Example — Ready to Build? (line 172)**
```
Estimated build time: 8 minutes
Ready to proceed? [Yes] [Modify]   ← approval gate
```

### Graph Validation

**Example — Architecture Analysis (lines 377-409)**
harAI analyzes the workflow before execution:
```
🧠 Detected: Full-stack native mobile app + workflow automation

ARCHITECTURE: [validates components]
📱 Mobile Apps: [checks 2 apps needed]
🔧 Backend: [validates DB, API, realtime]
🔐 Auth & Security: [validates auth config]
💳 Integrations: [validates all connectors available]
🤖 Workflows: [validates chains are complete]
```
**Implementation reference:** `graphCompiler.ts` should validate state contract consistency (outputs of source nodes match inputs of target nodes), reachability from entry, and no dangling edges.

---

## Phase 5 — AI Enhancements (Streaming, Multi-Model)

### Streaming Responses

**Example — Live Build Progress (lines 615-658)**
```
[1/8] 📋 Planning architecture...
  ✓ Mobile app (iOS + Android)
  ✓ Local SQLite database
  ✓ No backend needed (offline-first)

[2/8] 🎨 Designing UI...
  ✓ Home screen with recipe cards
  ...
```
Each line appears progressively — streaming AI output enables this real-time experience.

### Multi-Model Support

**Example — AI Model Hub (lines 566-603)**
```json
"text":   ["GPT-4", "Claude", "Llama", "Mixtral"]
"image":  ["SDXL", "DALL-E", "Midjourney API", "Flux"]
"audio":  ["Whisper", "ElevenLabs", "Suno", "MusicGen"]
"video":  ["RunwayML", "Pika", "Synthesia"]
"custom": ["HuggingFace (1000+)", "Modal", "Replicate"]
```
**Implementation reference:** `aiProviderRegistry.ts` should define an abstract `AIProvider` interface that `GeminiProvider`, future `OpenAIProvider`, and `AnthropicProvider` all implement.

**Example — Per-Node Model Selection (lines 569-572)**
```
"gpt4":   "Complex reasoning, code generation"
"claude":  "Long context, analysis"
"llama":   "Open-source, self-hosted"
"mixtral": "Fast inference"
```
Different nodes in the same workflow could use different models based on their task.

---

## Test Prompts for Each Phase

Use these prompts to validate each phase after implementation:

| Phase | Test Prompt |
|-------|------------|
| **1** | "When someone fills a form, analyze sentiment. If positive, send thank you email. If negative, alert the support team on Slack." |
| **1** | "Read my inbox, summarize each email, and if urgent send to Slack, otherwise log to Google Sheets." |
| **2** | "Build a content pipeline: take a blog topic, research it, write the article, generate social media posts, and create an image." |
| **3** | "When a new row is added to Google Sheets, read the data, generate a report with AI, save it to Google Drive, and notify the team on Slack." |
| **4** | "Process customer orders: validate payment, check inventory (if out of stock → notify warehouse, else → ship order), send confirmation email, update analytics." |
| **5** | "Transcribe an audio file with Whisper, summarize with Claude, generate social posts with GPT-4, and create a thumbnail with DALL-E." |
