import { ToolActionDefinition, ToolDefinition } from '../types';
import { isToolConnected, registerTool } from '../toolRegistry';
import { GoogleCallError, callGoogle, connectTool, disconnectTool } from '../googleClient';

// ==================== GMAIL CONSTANTS ====================

const GMAIL_TOOL_ID = 'gmail';
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const MAX_RETRIES = 3;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ==================== AUTH ====================

/**
 * Whether the server holds a Gmail credential for this operator.
 *
 * There is no token in the browser to inspect. This used to read localStorage and
 * report "connected" even for an expired token, on the assumption that a
 * background refresh timer would fix it — so a send could fail with an auth error
 * on a tool the UI showed as green. The server refreshes with a refresh token
 * before every call, so connected now means usable.
 */
function isGmailAvailable(): boolean {
  return isToolConnected(GMAIL_TOOL_ID);
}

// ==================== GMAIL API HELPERS ====================

/**
 * Typed error container for Gmail API failures.
 * Used internally for retry/dispatch logic.
 */
class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorType:
      'auth' | 'rate_limit' | 'invalid_recipient' | 'too_large' | 'generic',
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

/**
 * Map a proxy failure onto the Gmail error taxonomy this module branches on.
 *
 * The server already classified the upstream status; this only translates its
 * reason code, rather than re-parsing status numbers and response bodies in the
 * browser.
 */
function classifyProxyError(err: unknown): GmailApiError {
  if (!(err instanceof GoogleCallError)) {
    const message = err instanceof Error ? err.message : String(err);
    return new GmailApiError(message, 0, 'generic');
  }

  switch (err.code) {
    case 'not_connected':
    case 'refresh_unavailable':
    case 'google_auth_failed':
    case 'invalid_grant':
      return new GmailApiError(err.message, 401, 'auth');
    case 'google_rate_limited':
      return new GmailApiError(err.message, 429, 'rate_limit');
    case 'google_too_large':
      return new GmailApiError(err.message, 413, 'too_large');
    case 'google_rejected':
    case 'invalid_params':
      return new GmailApiError(err.message, 400, 'invalid_recipient');
    default:
      return new GmailApiError(err.message, err.status, 'generic');
  }
}

/**
 * Call one Gmail operation through the server.
 *
 * Replaces a direct `fetch` to gmail.googleapis.com that attached a bearer token
 * from localStorage and cleared that token on any 401.
 */
async function gmailCall<T>(
  operation: 'gmail_send_message' | 'gmail_list_messages' | 'gmail_get_message',
  params: Record<string, unknown>,
): Promise<T> {
  try {
    return await callGoogle<T>(operation, params);
  } catch (err) {
    throw classifyProxyError(err);
  }
}

/**
 * Retry wrapper with exponential backoff (1s, 2s, 4s).
 *
 * RATE LIMITS ONLY. It used to retry 'generic' failures too, which for a send is
 * unsafe: a request that times out or fails after Gmail accepted the message
 * would be sent again, delivering twice. A 429 is a refusal — nothing was
 * accepted — so retrying that is safe. Everything else is reported once and left
 * to the execution engine, which deliberately never retries an irreversible
 * action (see `nodeFailure.ts`).
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof GmailApiError) || err.errorType !== 'rate_limit') {
        throw err;
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }
  throw lastError;
}

// ==================== VALIDATION ====================

/** Validate email format */
function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/** Validate email list (comma-separated), returns invalid entries */
function validateRecipients(recipients: string): string[] {
  return recipients
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && !isValidEmail(e));
}

/** Auto-generate a subject line from the email body */
function generateSubjectFromBody(body: string): string {
  if (!body) return '(No subject)';
  // Take first sentence or first 60 chars
  const firstSentence = body
    .replace(/<[^>]*>/g, '')
    .split(/[.!?\n]/)[0]
    ?.trim();
  if (firstSentence && firstSentence.length <= 80) return firstSentence;
  return (
    body
      .replace(/<[^>]*>/g, '')
      .slice(0, 60)
      .trim() + '...'
  );
}

/** Full validation — returns array of error messages (empty = valid) */
function validateEmailData(input: Record<string, any>): string[] {
  const errors: string[] = [];

  // Required: at least one recipient
  if (!input.to || String(input.to).trim().length === 0) {
    errors.push('Missing recipient email address (to)');
  } else {
    const invalid = validateRecipients(String(input.to));
    invalid.forEach((e) => errors.push(`Invalid email format: "${e}"`));
  }

  // Required: body content
  if (!input.body || String(input.body).trim().length === 0) {
    errors.push('Email body is empty');
  }

  // Optional: validate CC/BCC if provided
  if (input.cc && String(input.cc).trim().length > 0) {
    const invalid = validateRecipients(String(input.cc));
    invalid.forEach((e) => errors.push(`Invalid CC email format: "${e}"`));
  }
  if (input.bcc && String(input.bcc).trim().length > 0) {
    const invalid = validateRecipients(String(input.bcc));
    invalid.forEach((e) => errors.push(`Invalid BCC email format: "${e}"`));
  }

  return errors;
}

// ==================== ENCODING ====================

/** Encode an email in RFC 2822 format for the Gmail API */
function encodeEmail(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  replyTo?: string,
): string {
  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
  ];

  if (cc) lines.splice(1, 0, `Cc: ${cc}`);
  if (bcc) lines.splice(1, 0, `Bcc: ${bcc}`);
  if (replyTo) lines.splice(1, 0, `Reply-To: ${replyTo}`);

  lines.push('', body);

  return btoa(unescape(encodeURIComponent(lines.join('\r\n'))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ==================== TOOL ACTIONS ====================

/**
 * ACTION: send_email
 * Core send with full validation, retry, and typed error handling.
 * - Reads:  to, subject, body, cc?, bcc?, reply_to?
 * - Writes: email_sent_id, email_status, sent_to, sent_at
 */
const sendEmailAction: ToolActionDefinition = {
  name: 'send_email',
  description: 'Send an email via Gmail with validation and retry.',
  capabilities: ['email.send'],
  // Once sent, an email cannot be recalled, so this always needs approval.
  sideEffect: 'irreversible',
  requiresAuth: true,
  costProfile: { latencyMs: 900, cost: 1, reliability: 9 },
  inputSchema: {
    to: {
      type: 'string',
      description: 'Recipient email address.',
      required: true,
      external: true,
      format: 'email',
    },
    subject: { type: 'string', description: 'Email subject line.', required: true },
    body: { type: 'string', description: 'Email body text.', required: true },
    cc: {
      type: 'string',
      description: 'Carbon-copy recipients, comma separated.',
      format: 'email',
    },
    bcc: {
      type: 'string',
      description: 'Blind-copy recipients, comma separated.',
      format: 'email',
    },
    reply_to: { type: 'string', description: 'Reply-To address.', format: 'email' },
  },
  outputSchema: {
    email_sent_id: { type: 'string', description: 'Gmail id of the sent message.' },
    email_status: { type: 'string', description: 'Outcome of the send attempt.' },
    sent_to: { type: 'string', description: 'Address the message went to.' },
    sent_at: { type: 'string', description: 'When it was sent.', format: 'date-time' },
  },
  execute: async (input) => {
    // Step 1: Check connector status
    if (!isGmailAvailable()) {
      return {
        email_sent_id: '',
        email_status:
          'Error: Gmail connector is not authenticated. Please connect Gmail in the sidebar.',
        error: 'Gmail is not authenticated. Connect Gmail before running this step.',
        sent_to: '',
        sent_at: '',
      };
    }

    // Step 2: Map common key variations to expected keys
    const to = String(
      input.to ||
        input.email_to ||
        input.recipient ||
        input.recipient_email ||
        input.email_recipient ||
        '',
    ).trim();
    const body = String(
      input.body ||
        input.email_body ||
        input.message ||
        input.content ||
        input.robot_story_content ||
        input.story_content ||
        input.story ||
        '',
    ).trim();
    let subject = String(input.subject || input.email_subject || '').trim();
    const cc = input.cc ? String(input.cc).trim() : undefined;
    const bcc = input.bcc ? String(input.bcc).trim() : undefined;
    const replyTo = input.reply_to ? String(input.reply_to).trim() : undefined;

    // Step 2: Auto-generate subject if missing
    if (!subject) {
      subject = generateSubjectFromBody(body);
    }

    // Step 3: Validate
    const errors = validateEmailData({ to, subject, body, cc, bcc });
    if (errors.length > 0) {
      return {
        email_sent_id: '',
        email_status: `Validation failed: ${errors.join('; ')}`,
        error: `Validation failed: ${errors.join('; ')}`,
        sent_to: to,
        sent_at: '',
      };
    }

    // Step 4: Send with retry logic
    console.log('✉️ [Gmail] Attempting to send email to:', to);
    console.log('✉️ [Gmail] Subject:', subject);
    console.log('✉️ [Gmail] Body preview:', body.substring(0, 100));
    try {
      const result = await withRetry(async () => {
        const raw = encodeEmail(to, subject, body, cc, bcc, replyTo);
        console.log('🌐 [Gmail] Calling Gmail API: POST /messages/send');
        return gmailCall<{ id: string }>('gmail_send_message', { raw });
      });

      // Step 5: Success
      console.log('✅ [Gmail] Email sent successfully! Message ID:', result.id);
      const sentAt = new Date().toISOString();
      return {
        email_sent_id: result.id || '',
        email_status: `Email sent successfully to ${to}` + (cc ? ` (CC: ${cc})` : ''),
        sent_to: to,
        sent_at: sentAt,
      };
    } catch (err) {
      // Step 5: Typed error handling
      console.error('❌ [Gmail] API call failed:', err);
      if (err instanceof GmailApiError) {
        console.error('❌ [Gmail] Error type:', err.errorType, 'Status:', err.statusCode);
        switch (err.errorType) {
          case 'auth':
            return {
              email_sent_id: '',
              sent_to: to,
              sent_at: '',
              email_status: 'Authentication expired. Please reconnect Gmail and retry.',
              error: 'Authentication expired. Please reconnect Gmail and retry.',
            };
          case 'rate_limit':
            return {
              email_sent_id: '',
              sent_to: to,
              sent_at: '',
              email_status: 'Gmail rate limit exceeded after 3 retries. Try again later.',
              error: 'Gmail rate limit exceeded after 3 retries. Try again later.',
            };
          case 'invalid_recipient':
            return {
              email_sent_id: '',
              sent_to: to,
              sent_at: '',
              email_status: `Recipient "${to}" was rejected by Gmail. Verify the address.`,
              error: `Recipient "${to}" was rejected by Gmail. Verify the address.`,
            };
          case 'too_large':
            return {
              email_sent_id: '',
              sent_to: to,
              sent_at: '',
              email_status: 'Email exceeds Gmail 25 MB limit. Consider using a Google Drive link.',
              error: 'Email exceeds Gmail 25 MB limit. Consider using a Google Drive link.',
            };
        }
      }
      return {
        email_sent_id: '',
        sent_to: to,
        sent_at: '',
        email_status: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
        error: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/**
 * ACTION: read_inbox
 * Read and search emails from Gmail inbox based on search filter if exists.
 * - Reads:  query?, max_results?
 * - Writes: emails, email_count
 */
const readInboxAction: ToolActionDefinition = {
  name: 'read_inbox',
  description: 'Read messages from the Gmail inbox, optionally filtered by a search query.',
  capabilities: ['email.read'],
  sideEffect: 'read',
  requiresAuth: true,
  costProfile: { latencyMs: 1200, cost: 1, reliability: 9 },
  inputSchema: {
    query: { type: 'string', description: 'Gmail search filter, for example "is:unread".' },
    max_results: { type: 'number', description: 'How many messages to read. Defaults to 5.' },
  },
  outputSchema: {
    emails: {
      type: 'array',
      description: 'Messages that matched.',
      items: { type: 'object', description: 'One message with id, from, subject and snippet.' },
    },
    email_count: { type: 'number', description: 'How many messages were returned.' },
  },
  execute: async (input) => {
    if (!isGmailAvailable()) {
      // Was `{ emails: '[]', email_count: '0' }` — an empty inbox is
      // indistinguishable from a disconnected one, so downstream steps
      // summarised "no messages" when the real problem was no token.
      return {
        emails: [],
        email_count: 0,
        error: 'Gmail is not authenticated. Connect Gmail before running this step.',
      };
    }

    const query = String(input.query || '');
    const maxResults = Math.min(Number(input.max_results) || 5, 20);

    try {
      const listResult = await withRetry(() =>
        gmailCall<{ messages: Array<{ id: string }> }>('gmail_list_messages', {
          maxResults,
          query,
        }),
      );

      if (!listResult.messages || listResult.messages.length === 0) {
        return { emails: [], email_count: 0 };
      }

      // The proxy already reduces each message to the header fields this
      // product shows, so there is no payload walking to do here.
      const emailDetails = await Promise.all(
        listResult.messages
          .slice(0, maxResults)
          .map((msg: { id: string }) => gmailCall('gmail_get_message', { id: msg.id })),
      );

      return { emails: emailDetails, email_count: emailDetails.length };
    } catch (err) {
      // Report through `error`, the channel the engine reads. This used to
      // return the message inside `emails` / `email_count`, so a failure
      // arrived downstream as if it were inbox content.
      const message = err instanceof Error ? err.message : String(err);
      return { emails: [], email_count: 0, error: message };
    }
  },
};

/**
 * ACTION: compose_and_send
 * High-level "smart send" — accepts context from any upstream node,
 * extracts email parameters, validates, and sends.
 * This action is designed for AI-driven workflows where the previous node
 * generates email content as part of a larger analysis.
 * - Reads:  email_draft OR (to, subject, body), context?
 * - Writes: email_sent_id, email_status, sent_to, sent_at
 */
const composeAndSendAction: ToolActionDefinition = {
  name: 'compose_and_send',
  description:
    'Assemble an email from upstream workflow state (or a structured email_draft), then validate and send it. Use this when an earlier step produced the content.',
  capabilities: ['email.send'],
  sideEffect: 'irreversible',
  requiresAuth: true,
  costProfile: { latencyMs: 1000, cost: 1, reliability: 8 },
  // This action deliberately accepts many aliases because it collects content
  // produced by earlier steps, whose key names vary by workflow.
  inputSchema: {
    email_draft: {
      type: 'object',
      description: 'Structured draft with to, subject and body. Takes precedence when present.',
    },
    to: { type: 'string', description: 'Recipient address.', external: true, format: 'email' },
    subject: { type: 'string', description: 'Subject line.' },
    body: { type: 'string', description: 'Body text.' },
    cc: { type: 'string', description: 'Carbon-copy recipients.', format: 'email' },
    bcc: { type: 'string', description: 'Blind-copy recipients.', format: 'email' },
    reply_to: { type: 'string', description: 'Reply-To address.', format: 'email' },
    context: { type: 'string', description: 'Free-form upstream context to draw content from.' },
    email_to: { type: 'string', description: 'Alias for to.', format: 'email' },
    email_subject: { type: 'string', description: 'Alias for subject.' },
    email_body: { type: 'string', description: 'Alias for body.' },
    recipient: { type: 'string', description: 'Alias for to.', format: 'email' },
    message: { type: 'string', description: 'Alias for body.' },
    content: { type: 'string', description: 'Alias for body.' },
    email_recipient: { type: 'string', description: 'Alias for to.', format: 'email' },
    robot_story_content: { type: 'string', description: 'Upstream content alias.' },
    story: { type: 'string', description: 'Upstream content alias.' },
    story_content: { type: 'string', description: 'Upstream content alias.' },
  },
  outputSchema: {
    email_sent_id: { type: 'string', description: 'Gmail id of the sent message.' },
    email_status: { type: 'string', description: 'Outcome of the send attempt.' },
    sent_to: { type: 'string', description: 'Address the message went to.' },
    sent_at: { type: 'string', description: 'When it was sent.', format: 'date-time' },
  },
  execute: async (input) => {
    // Extract email data — prefer structured email_draft, fall back to individual keys
    let emailData: Record<string, any> = {};

    if (input.email_draft) {
      // Parse email_draft if it's a JSON string
      try {
        emailData =
          typeof input.email_draft === 'string' ? JSON.parse(input.email_draft) : input.email_draft;
      } catch {
        emailData = {};
      }
    }

    // Overlay individual fields (they take priority)
    // Check ALL common variations the AI might produce
    const merged = {
      to:
        input.to ||
        input.email_to ||
        input.recipient ||
        input.email_recipient ||
        emailData.to ||
        '',
      subject: input.subject || input.email_subject || emailData.subject || '',
      // Check for story/content variations that AI generates
      body:
        input.body ||
        input.email_body ||
        input.message ||
        input.content ||
        input.robot_story_content ||
        input.story_content ||
        input.story ||
        emailData.body ||
        '',
      cc: input.cc || emailData.cc,
      bcc: input.bcc || emailData.bcc,
      reply_to: input.reply_to || emailData.reply_to,
    };

    // Delegate to the core send action
    return sendEmailAction.execute(merged);
  },
};

// ==================== GMAIL TOOL DEFINITION ====================

const gmailTool: ToolDefinition = {
  id: GMAIL_TOOL_ID,
  name: 'Gmail',
  description:
    'Send and read emails via the Gmail API, with validation, retry, and context-aware composition.',
  icon: 'Mail',
  color: '#EA4335',
  category: 'communication',
  costProfile: { latencyMs: 1000, cost: 1, reliability: 9 },
  scopes: GMAIL_SCOPES,
  actions: [sendEmailAction, readInboxAction, composeAndSendAction],

  isAuthenticated: () => isGmailAvailable(),

  /**
   * Open the server-driven consent flow.
   *
   * This used to run the Google Identity Services *token* client in the page,
   * which returns an access token straight to JavaScript and issues no refresh
   * token. The server now runs the authorization-code flow with PKCE, keeps the
   * client secret and the refresh token, and this only learns whether it worked.
   */
  authenticate: () => connectTool(GMAIL_TOOL_ID),

  disconnect: () => {
    // Revocation happens server side, with the token in the request BODY.
    // The browser used to put it in a query string, where it lands in logs.
    void disconnectTool(GMAIL_TOOL_ID).catch((err: GoogleCallError) =>
      console.warn(`[${GMAIL_TOOL_ID}] disconnect failed:`, err.message),
    );
  },
};

// ==================== SELF-REGISTER ====================
registerTool(gmailTool);

export default gmailTool;
