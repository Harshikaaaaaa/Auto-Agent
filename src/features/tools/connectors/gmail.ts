import { ToolActionDefinition, ToolAuth, ToolDefinition } from '../types';
import { registerTool, saveToolAuth, loadToolAuth, clearToolAuth, silentRefreshGoogleToken } from '../toolRegistry';

// ==================== GMAIL CONSTANTS ====================

const GMAIL_TOOL_ID = 'gmail';
const GMAIL_SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly'
];
const MAX_RETRIES = 3;
const SEND_TIMEOUT_MS = 30_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ==================== AUTH HELPERS ====================

function getStoredAuth(): (ToolAuth & { expired?: boolean }) | null {
    return loadToolAuth(GMAIL_TOOL_ID);
}

async function getAccessToken(): Promise<string | null> {
    const auth = getStoredAuth();
    if (!auth) return null;

    const isExpired = auth.expiresAt <= Date.now() + 60_000;
    if ((auth as any).expired || isExpired) {
        const refreshed = await silentRefreshGoogleToken(GMAIL_TOOL_ID, GMAIL_SCOPES);
        if (!refreshed) {
            clearToolAuth(GMAIL_TOOL_ID);
            return null;
        }
        const fresh = loadToolAuth(GMAIL_TOOL_ID);
        return fresh?.accessToken ?? null;
    }

    return auth.accessToken;
}

/**
 * Returns true if user has previously connected Gmail — even if the token has expired.
 * The proactive refresh timer in toolRegistry will handle renewing it.
 */
function isGmailAvailable(): boolean {
    const auth = getStoredAuth();
    return auth !== null; // connected = has auth record, regardless of expiry
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
        public readonly errorType: 'auth' | 'rate_limit' | 'invalid_recipient' | 'too_large' | 'generic'
    ) {
        super(message);
        this.name = 'GmailApiError';
    }
}

/** Classify HTTP status into a typed error */
function classifyError(status: number, body: string): GmailApiError {
    if (status === 401 || status === 403) {
        return new GmailApiError(
            'Gmail authentication expired. Please reconnect Gmail.',
            status, 'auth'
        );
    }
    if (status === 429) {
        return new GmailApiError(
            'Gmail API rate limit exceeded. Retrying...',
            status, 'rate_limit'
        );
    }
    if (status === 400 && body.includes('invalidArgument')) {
        return new GmailApiError(
            'Invalid email recipient or format.',
            status, 'invalid_recipient'
        );
    }
    if (status === 413) {
        return new GmailApiError(
            'Email too large — Gmail limit is 25 MB.',
            status, 'too_large'
        );
    }
    return new GmailApiError(
        `Gmail API error (${status}): ${body.slice(0, 200)}`,
        status, 'generic'
    );
}

/** Authenticated fetch wrapper for Gmail API v1 */
async function gmailApiFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    const token = await getAccessToken();
    if (!token) {
        throw new GmailApiError(
            'Gmail not authenticated. Please connect Gmail first.',
            401, 'auth'
        );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
        const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`,
            {
                ...options,
                signal: controller.signal,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...(options.headers || {})
                }
            }
        );

        if (!response.ok) {
            const errorBody = await response.text();
            if (response.status === 401 || response.status === 403) {
                clearToolAuth(GMAIL_TOOL_ID);
            }
            throw classifyError(response.status, errorBody);
        }

        return response.json();
    } catch (err) {
        if (err instanceof GmailApiError) throw err;
        if ((err as Error).name === 'AbortError') {
            throw new GmailApiError('Gmail API request timed out (30s).', 408, 'generic');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Retry wrapper with exponential backoff (1s, 2s, 4s).
 * Only retries on rate_limit and generic errors.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (err instanceof GmailApiError) {
                // Don't retry auth, invalid_recipient, or too_large — they won't change
                if (err.errorType !== 'rate_limit' && err.errorType !== 'generic') {
                    throw err;
                }
            }
            if (attempt < MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
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
        .map(e => e.trim())
        .filter(e => e.length > 0 && !isValidEmail(e));
}

/** Auto-generate a subject line from the email body */
function generateSubjectFromBody(body: string): string {
    if (!body) return '(No subject)';
    // Take first sentence or first 60 chars
    const firstSentence = body.replace(/<[^>]*>/g, '').split(/[.!?\n]/)[0]?.trim();
    if (firstSentence && firstSentence.length <= 80) return firstSentence;
    return body.replace(/<[^>]*>/g, '').slice(0, 60).trim() + '...';
}

/** Full validation — returns array of error messages (empty = valid) */
function validateEmailData(input: Record<string, any>): string[] {
    const errors: string[] = [];

    // Required: at least one recipient
    if (!input.to || String(input.to).trim().length === 0) {
        errors.push('Missing recipient email address (to)');
    } else {
        const invalid = validateRecipients(String(input.to));
        invalid.forEach(e => errors.push(`Invalid email format: "${e}"`));
    }

    // Required: body content
    if (!input.body || String(input.body).trim().length === 0) {
        errors.push('Email body is empty');
    }

    // Optional: validate CC/BCC if provided
    if (input.cc && String(input.cc).trim().length > 0) {
        const invalid = validateRecipients(String(input.cc));
        invalid.forEach(e => errors.push(`Invalid CC email format: "${e}"`));
    }
    if (input.bcc && String(input.bcc).trim().length > 0) {
        const invalid = validateRecipients(String(input.bcc));
        invalid.forEach(e => errors.push(`Invalid BCC email format: "${e}"`));
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
    replyTo?: string
): string {
    const lines: string[] = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0'
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
            format: 'email'
        },
        subject: { type: 'string', description: 'Email subject line.', required: true },
        body: { type: 'string', description: 'Email body text.', required: true },
        cc: { type: 'string', description: 'Carbon-copy recipients, comma separated.', format: 'email' },
        bcc: { type: 'string', description: 'Blind-copy recipients, comma separated.', format: 'email' },
        reply_to: { type: 'string', description: 'Reply-To address.', format: 'email' }
    },
    outputSchema: {
        email_sent_id: { type: 'string', description: 'Gmail id of the sent message.' },
        email_status: { type: 'string', description: 'Outcome of the send attempt.' },
        sent_to: { type: 'string', description: 'Address the message went to.' },
        sent_at: { type: 'string', description: 'When it was sent.', format: 'date-time' }
    },
    execute: async (input) => {
        // Step 1: Check connector status
        if (!isGmailAvailable()) {
            return {
                email_sent_id: '',
                email_status: 'Error: Gmail connector is not authenticated. Please connect Gmail in the sidebar.',
                sent_to: '',
                sent_at: ''
            };
        }

        // Step 2: Map common key variations to expected keys
        const to = String(input.to || input.email_to || input.recipient || input.recipient_email || input.email_recipient || '').trim();
        const body = String(input.body || input.email_body || input.message || input.content || input.robot_story_content || input.story_content || input.story || '').trim();
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
                sent_to: to,
                sent_at: ''
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
                return gmailApiFetch('messages/send', {
                    method: 'POST',
                    body: JSON.stringify({ raw })
                });
            });

            // Step 5: Success
            console.log('✅ [Gmail] Email sent successfully! Message ID:', result.id);
            const sentAt = new Date().toISOString();
            return {
                email_sent_id: result.id || '',
                email_status: `Email sent successfully to ${to}` + (cc ? ` (CC: ${cc})` : ''),
                sent_to: to,
                sent_at: sentAt
            };
        } catch (err) {
            // Step 5: Typed error handling
            console.error('❌ [Gmail] API call failed:', err);
            if (err instanceof GmailApiError) {
                console.error('❌ [Gmail] Error type:', err.errorType, 'Status:', err.statusCode);
                switch (err.errorType) {
                    case 'auth':
                        return {
                            email_sent_id: '', sent_to: to, sent_at: '',
                            email_status: 'Authentication expired. Please reconnect Gmail and retry.'
                        };
                    case 'rate_limit':
                        return {
                            email_sent_id: '', sent_to: to, sent_at: '',
                            email_status: 'Gmail rate limit exceeded after 3 retries. Try again later.'
                        };
                    case 'invalid_recipient':
                        return {
                            email_sent_id: '', sent_to: to, sent_at: '',
                            email_status: `Recipient "${to}" was rejected by Gmail. Verify the address.`
                        };
                    case 'too_large':
                        return {
                            email_sent_id: '', sent_to: to, sent_at: '',
                            email_status: 'Email exceeds Gmail 25 MB limit. Consider using a Google Drive link.'
                        };
                }
            }
            return {
                email_sent_id: '', sent_to: to, sent_at: '',
                email_status: `Failed to send: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }
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
        max_results: { type: 'number', description: 'How many messages to read. Defaults to 5.' }
    },
    outputSchema: {
        emails: {
            type: 'array',
            description: 'Messages that matched.',
            items: { type: 'object', description: 'One message with id, from, subject and snippet.' }
        },
        email_count: { type: 'number', description: 'How many messages were returned.' }
    },
    execute: async (input) => {
        if (!isGmailAvailable()) {
            return {
                emails: '[]',
                email_count: '0'
            };
        }

        const query = String(input.query || '');
        const maxResults = Math.min(Number(input.max_results) || 5, 20);

        try {
            const listResult = await withRetry(() =>
                gmailApiFetch(
                    `messages?maxResults=${maxResults}${query ? `&q=${encodeURIComponent(query)}` : ''}`
                )
            );

            if (!listResult.messages || listResult.messages.length === 0) {
                return {
                    emails: JSON.stringify([]),
                    email_count: '0'
                };
            }

            const emailDetails = await Promise.all(
                listResult.messages.slice(0, maxResults).map(async (msg: { id: string }) => {
                    const detail = await gmailApiFetch(
                        `messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
                    );
                    const headers = detail.payload?.headers || [];
                    const getHeader = (name: string) =>
                        headers.find((h: any) => h.name === name)?.value || '';

                    return {
                        id: detail.id,
                        subject: getHeader('Subject'),
                        from: getHeader('From'),
                        date: getHeader('Date'),
                        snippet: detail.snippet || ''
                    };
                })
            );

            return {
                emails: JSON.stringify(emailDetails),
                email_count: String(emailDetails.length)
            };
        } catch (err) {
            if (err instanceof GmailApiError && err.errorType === 'auth') {
                return { emails: '[]', email_count: 'Error: Gmail auth expired. Reconnect.' };
            }
            return {
                emails: `Error: ${err instanceof Error ? err.message : String(err)}`,
                email_count: '0'
            };
        }
    }
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
            description: 'Structured draft with to, subject and body. Takes precedence when present.'
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
        story_content: { type: 'string', description: 'Upstream content alias.' }
    },
    outputSchema: {
        email_sent_id: { type: 'string', description: 'Gmail id of the sent message.' },
        email_status: { type: 'string', description: 'Outcome of the send attempt.' },
        sent_to: { type: 'string', description: 'Address the message went to.' },
        sent_at: { type: 'string', description: 'When it was sent.', format: 'date-time' }
    },
    execute: async (input) => {
        // Extract email data — prefer structured email_draft, fall back to individual keys
        let emailData: Record<string, any> = {};

        if (input.email_draft) {
            // Parse email_draft if it's a JSON string
            try {
                emailData = typeof input.email_draft === 'string'
                    ? JSON.parse(input.email_draft)
                    : input.email_draft;
            } catch {
                emailData = {};
            }
        }

        // Overlay individual fields (they take priority)
        // Check ALL common variations the AI might produce
        const merged = {
            to: input.to || input.email_to || input.recipient || input.email_recipient || emailData.to || '',
            subject: input.subject || input.email_subject || emailData.subject || '',
            // Check for story/content variations that AI generates
            body: input.body || input.email_body || input.message || input.content ||
                input.robot_story_content || input.story_content || input.story ||
                emailData.body || '',
            cc: input.cc || emailData.cc,
            bcc: input.bcc || emailData.bcc,
            reply_to: input.reply_to || emailData.reply_to
        };

        // Delegate to the core send action
        return sendEmailAction.execute(merged);
    }
};

// ==================== GMAIL TOOL DEFINITION ====================

declare global {
    interface Window {
        google?: {
            accounts: {
                oauth2: {
                    initTokenClient: (config: any) => any;
                };
            };
        };
    }
}

const gmailTool: ToolDefinition = {
    id: GMAIL_TOOL_ID,
    name: 'Gmail',
    description: 'Send and read emails via the Gmail API, with validation, retry, and context-aware composition.',
    icon: 'Mail',
    color: '#EA4335',
    category: 'communication',
    costProfile: { latencyMs: 1000, cost: 1, reliability: 9 },
    scopes: GMAIL_SCOPES,
    actions: [sendEmailAction, readInboxAction, composeAndSendAction],

    isAuthenticated: () => isGmailAvailable(),

    authenticate: () => {
        return new Promise<void>((resolve, reject) => {
            const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID ||
                (typeof process !== 'undefined' && (process as any).env?.GOOGLE_CLIENT_ID);

            if (!clientId) {
                reject(new Error('VITE_GOOGLE_CLIENT_ID not set in .env.local'));
                return;
            }

            if (!window.google?.accounts?.oauth2) {
                reject(new Error('Google Identity Services not loaded. Check that the GIS script is in index.html.'));
                return;
            }

            clearToolAuth(GMAIL_TOOL_ID);

            const tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: GMAIL_SCOPES.join(' '),
                prompt: '',
                callback: (response: any) => {
                    if (response.error) {
                        reject(new Error(response.error));
                        return;
                    }

                    const expiresAt = Date.now() + (response.expires_in * 1000);
                    const auth: ToolAuth = {
                        toolId: GMAIL_TOOL_ID,
                        accessToken: response.access_token,
                        expiresAt,
                        scopes: GMAIL_SCOPES
                    };

                    console.log(`💾 [Gmail Auth] Saving token - ExpiresIn: ${response.expires_in}s, ExpiresAt: ${expiresAt}, Now: ${Date.now()}`);
                    saveToolAuth(auth);
                    console.log(`✅ [Gmail Auth] Token saved successfully`);
                    resolve();
                }
            });

            tokenClient.requestAccessToken();
        });
    },

    disconnect: () => {
        const auth = getStoredAuth();
        if (auth?.accessToken) {
            // Revoke the token with Google (best effort)
            fetch(`https://oauth2.googleapis.com/revoke?token=${auth.accessToken}`, {
                method: 'POST'
            }).catch(() => { /* best effort */ });
        }
        clearToolAuth(GMAIL_TOOL_ID);
    }
};

// ==================== SELF-REGISTER ====================
registerTool(gmailTool);

export default gmailTool;
