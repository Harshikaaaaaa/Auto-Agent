---
description: How to send emails via the Gmail connector skill
---

# Email Tool Skill

## When to Use
- User requests to "send an email" in a workflow
- Workflow node produces email content to be sent
- AI generates a node with `toolId: "gmail"` and `toolAction: "send_email"` or `"compose_and_send"`

## Prerequisites
1. `VITE_GOOGLE_CLIENT_ID` must be set in `.env.local`
2. Gmail connector must be authenticated (green dot in sidebar)
3. Gmail API enabled in Google Cloud Console

## Available Actions

### `send_email`
Direct send with validation, retry, and typed errors.
- **Reads:** `to` (required), `subject` (auto-generated if missing), `body` (required), `cc`, `bcc`, `reply_to`
- **Writes:** `email_sent_id`, `email_status`, `sent_to`, `sent_at`

### `read_inbox`
Search and read emails from inbox.
- **Reads:** `query` (optional filter), `max_results` (default 5, max 20)
- **Writes:** `emails` (JSON array), `email_count`

### `compose_and_send`
Smart compose — accepts structured `email_draft` JSON or individual fields from upstream AI nodes.
- **Reads:** `email_draft` (JSON with to/subject/body) OR `to`, `subject`, `body`, plus `cc`, `bcc`, `reply_to`, `context`
- **Writes:** `email_sent_id`, `email_status`, `sent_to`, `sent_at`

## Built-In Protections
- **Email format validation** via regex before sending
- **Auto-subject generation** from body if subject is missing
- **Retry with exponential backoff** (1s → 2s → 4s, max 3 attempts) on rate limits
- **30s timeout** per API request
- **Typed errors**: auth, rate_limit, invalid_recipient, too_large, generic
- **CC/BCC/Reply-To support**

## How the AI Uses Tools
When the user's prompt involves email and Gmail is connected:
1. `geminiService.ts` includes Gmail's actions in the prompt
2. Gemini creates a node with `toolId: "gmail"`, `toolAction: "send_email"`
3. During execution, `useWorkflowExecution.ts` routes to `gmailTool.actions[].execute()`
4. The Gmail connector calls the API directly (skips AI for the send step)

## Error Handling
| Error Type | User-Facing Message |
|---|---|
| `auth` | "Authentication expired. Please reconnect Gmail and retry." |
| `rate_limit` | "Gmail rate limit exceeded after 3 retries. Try again later." |
| `invalid_recipient` | "Recipient was rejected by Gmail. Verify the address." |
| `too_large` | "Email exceeds Gmail 25 MB limit. Consider a Google Drive link." |
| `generic` | Raw error with truncated API response |

## File Locations
- Connector: `src/features/tools/connectors/gmail.ts`
- Types: `src/features/tools/types.ts`
- Registry: `src/features/tools/toolRegistry.ts`
- Hook: `src/features/tools/useTools.ts`
