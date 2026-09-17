# How to Add New Skills/Tools to AutoAgent

## 📁 Location

Add new tools/connectors in:
```
src/features/tools/connectors/
```

### Current Structure
```
src/features/tools/
├── connectors/
│   ├── gmail.ts          ← Example connector
│   └── index.ts          ← Auto-registers all connectors
├── toolRegistry.ts       ← Central registry
├── types.ts              ← Type definitions
└── useTools.ts           ← React hook for tool UI
```

## 🚀 Quick Start: Adding a New Tool

### Step 1: Create Your Tool File

Create a new file in `src/features/tools/connectors/`:

```
src/features/tools/connectors/your-tool.ts
```

### Step 2: Import and Register

Add your tool to the barrel file:

**`src/features/tools/connectors/index.ts`**:
```typescript
import './gmail';
import './your-tool';  // ← Add this line
```

## 📝 Tool Template

Here's a complete template for creating a new tool:

```typescript
// src/features/tools/connectors/slack.ts (example)

import { Tool, ToolAction } from '../types';
import { registerTool, saveToolAuth, loadToolAuth, clearToolAuth } from '../toolRegistry';

// ==================== CONSTANTS ====================

const SLACK_TOOL_ID = 'slack';
const SLACK_SCOPES = [
    'chat:write',
    'channels:read'
];

// ==================== AUTH HELPERS ====================

function getStoredAuth() {
    return loadToolAuth(SLACK_TOOL_ID);
}

function isSlackAvailable(): boolean {
    const auth = getStoredAuth();
    return auth !== null && auth.expiresAt > Date.now();
}

// ==================== TOOL ACTIONS ====================

/**
 * ACTION: send_message
 * Send a message to a Slack channel
 */
const sendMessageAction: ToolAction = {
    name: 'send_message',
    description: 'Send a message to a Slack channel. Reads: channel, message. Writes: message_id, status.',
    inputKeys: ['channel', 'message'],           // What this action reads from workflow state
    outputKeys: ['message_id', 'status'],        // What this action writes to workflow state
    execute: async (input) => {
        // Check authentication
        if (!isSlackAvailable()) {
            return {
                message_id: '',
                status: 'Error: Slack not authenticated'
            };
        }

        // Extract inputs
        const channel = String(input.channel || '').trim();
        const message = String(input.message || '').trim();

        // Validate
        if (!channel || !message) {
            return {
                message_id: '',
                status: 'Error: Missing channel or message'
            };
        }

        // Call API
        try {
            const auth = getStoredAuth();
            const response = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${auth?.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    channel: channel,
                    text: message
                })
            });

            const data = await response.json();

            if (!data.ok) {
                return {
                    message_id: '',
                    status: `Error: ${data.error}`
                };
            }

            return {
                message_id: data.ts,
                status: 'Message sent successfully'
            };
        } catch (error) {
            return {
                message_id: '',
                status: `Error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
};

// ==================== TOOL DEFINITION ====================

const slackTool: Tool = {
    id: SLACK_TOOL_ID,
    name: 'Slack',
    description: 'Send messages and interact with Slack',
    icon: 'MessageSquare',         // Lucide React icon name
    color: '#4A154B',              // Slack brand color
    scopes: SLACK_SCOPES,
    actions: [sendMessageAction],  // Add all actions here

    isAuthenticated: () => isSlackAvailable(),

    authenticate: () => {
        return new Promise<void>((resolve, reject) => {
            // Implement OAuth flow here
            // For Slack, you'd use Slack OAuth
            // For simplicity, here's a mock:
            
            const clientId = import.meta.env?.VITE_SLACK_CLIENT_ID;
            
            if (!clientId) {
                reject(new Error('VITE_SLACK_CLIENT_ID not set'));
                return;
            }

            // Actual implementation would open OAuth popup
            // and exchange code for token
            // This is a simplified example
            
            // Save mock auth for demonstration
            const auth = {
                toolId: SLACK_TOOL_ID,
                accessToken: 'mock-token',
                expiresAt: Date.now() + 3600000, // 1 hour
                scopes: SLACK_SCOPES
            };
            
            saveToolAuth(auth);
            resolve();
        });
    },

    disconnect: () => {
        clearToolAuth(SLACK_TOOL_ID);
    }
};

// ==================== SELF-REGISTER ====================
registerTool(slackTool);

export default slackTool;
```

## 🎨 Icon Options

Use any [Lucide React](https://lucide.dev/) icon name:

- Gmail: `'Mail'`
- Slack: `'MessageSquare'`
- Sheets: `'Table'`
- Calendar: `'Calendar'`
- Drive: `'FolderOpen'`
- Twitter: `'Twitter'`
- Notion: `'FileText'`

## 🔑 Environment Variables

Add OAuth credentials to `.env.local`:

```bash
# Gmail
VITE_GOOGLE_CLIENT_ID=your-google-client-id

# Slack (example)
VITE_SLACK_CLIENT_ID=your-slack-client-id
VITE_SLACK_CLIENT_SECRET=your-secret

# Add more as needed
```

## 📚 Key Concepts

### 1. Tool Actions

Each tool can have multiple actions. Actions are the actual operations that can be performed in a workflow node.

**Example:** Gmail has 3 actions:
- `send_email` - Send an email
- `read_inbox` - Read emails
- `compose_and_send` - Smart composer

### 2. State Contracts

Actions declare what they **read** (inputKeys) and **write** (outputKeys):

```typescript
inputKeys: ['email_to', 'email_subject', 'email_body']
outputKeys: ['email_sent_id', 'email_status', 'sent_at']
```

This tells the workflow what data flows between nodes.

### 3. Auto-Registration

The `registerTool()` call at the bottom automatically adds your tool to the global registry when imported.

```typescript
registerTool(slackTool);
```

### 4. Authentication

AutoAgent uses OAuth tokens stored in localStorage. Your tool needs to implement:

- `isAuthenticated()` - Check if token is valid
- `authenticate()` - Trigger OAuth flow
- `disconnect()` - Clear stored token

## 🧪 Testing Your Tool

1. **Import the connector**:
   Already done via `connectors/index.ts`

2. **Start dev server**:
   ```bash
   npm run dev
   ```

3. **Check sidebar**:
   Your tool should appear in the "Connected Tools" section

4. **Authenticate**:
   Click your tool to authenticate

5. **Use in workflow**:
   - Generate a workflow that uses your tool
   - Or manually create a "Tool" node and select your action

## 📋 Examples of Tools You Can Add

### 1. Google Sheets
```typescript
Actions:
- read_sheet: Read data from a spreadsheet
- write_row: Append a row
- update_cell: Update specific cell
```

### 2. Slack
```typescript
Actions:
- send_message: Post to channel
- send_dm: Direct message user
- create_channel: Create new channel
```

### 3. Notion
```typescript
Actions:
- create_page: Create new page
- update_database: Add entry to database
- search: Search Notion workspace
```

### 4. Calendar
```typescript
Actions:
- create_event: Schedule meeting
- list_events: Get upcoming events
- send_invite: Send calendar invite
```

### 5. Twitter
```typescript
Actions:
- post_tweet: Post a tweet
- schedule_tweet: Schedule for later
- reply: Reply to tweet
```

## 🎯 Best Practices

1. **Comprehensive Error Handling**:
   - Always check authentication first
   - Validate inputs before API calls
   - Return user-friendly error messages

2. **Input Flexibility**:
   - Accept multiple input key variations (like Gmail does)
   - Example: `email_body`, `body`, `message`, `content`

3. **Clear Output Keys**:
   - Use descriptive names: `email_sent_id`, not `id`
   - Include status in outputs

4. **Logging**:
   - Use console.log with emoji prefixes for clarity
   - Example: `console.log('✉️ [Gmail] Sending email...')`

5. **Retry Logic** (for production):
   - Implement exponential backoff for rate limits
   - Don't retry auth errors

6. **Rate Limiting**:
   - Respect API rate limits
   - Add delays between requests if needed

## 🔗 How It All Works Together

```
User Creates Workflow
        ↓
   Drag Tool Node
        ↓
   Select Your Tool's Action
        ↓
   Configure Input/Output Keys
        ↓
   Run Workflow
        ↓
   Pre-execution Auth Check ← (We just added this!)
        ↓
   Execute Your Action
        ↓
   Write Outputs to State
        ↓
   Next Node Reads State
```

## 📖 Full File Structure Example

```
src/features/tools/
├── connectors/
│   ├── index.ts              ← Import all tools here
│   ├── gmail.ts              ← 546 lines, full example
│   ├── slack.ts              ← Your new tool
│   ├── sheets.ts             ← Another new tool
│   └── notion.ts             ← Another new tool
├── toolRegistry.ts
├── types.ts
└── useTools.ts
```

## 🚀 Next Steps

1. Create your tool file in `src/features/tools/connectors/your-tool.ts`
2. Copy the template above and customize
3. Add to `connectors/index.ts`
4. Add OAuth credentials to `.env.local` (if needed)
5. Test in the app!

---

**Need help?** The `gmail.ts` file is the most complete reference with validation, retry logic, and multiple actions. Start there for inspiration! 🎉
