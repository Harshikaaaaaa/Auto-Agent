import { apiUrl } from '@config/api';

/**
 * The browser's only route to Google.
 *
 * Connectors used to hold an access token from localStorage and call
 * googleapis.com directly with `Authorization: Bearer <token>`. The token is now
 * held, refreshed and attached by the server; the browser names an operation from
 * the server's allowlist and gets back a normalised result.
 */

export type GoogleOperation =
    | 'gmail_send_message'
    | 'gmail_list_messages'
    | 'gmail_get_message'
    | 'sheets_create_spreadsheet'
    | 'sheets_get_values'
    | 'sheets_update_values'
    | 'sheets_append_values'
    | 'drive_list_files'
    | 'drive_upload_file'
    | 'drive_download_file';

/** A failure from the proxy, carrying the server's reason code. */
export class GoogleCallError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(message: string, status: number, code: string) {
        super(message);
        this.name = 'GoogleCallError';
        this.status = status;
        this.code = code;
    }

    /** The stored authorization is missing, expired beyond repair, or rejected. */
    get needsReconnect(): boolean {
        return (
            this.status === 401 ||
            this.code === 'not_connected' ||
            this.code === 'refresh_unavailable' ||
            this.code === 'google_auth_failed'
        );
    }
}

interface ProxyResponse<T> {
    result?: T;
    error?: string;
    message?: string;
}

/**
 * Ask the server to perform one Google operation.
 *
 * @throws GoogleCallError with a message written for the user, and a code the
 *         connector can map onto the engine's failure taxonomy.
 */
export async function callGoogle<T = Record<string, unknown>>(
    operation: GoogleOperation,
    params: Record<string, unknown> = {}
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(apiUrl('/api/google/call'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ operation, params })
        });
    } catch {
        // The underlying fetch TypeError is deliberately dropped: this message is
        // shown to the user, and a "Failed to fetch" adds nothing they can act on.
        throw new GoogleCallError(
            'Could not reach the AutoAgent server. Is it running?',
            0,
            'network_error'
        );
    }

    let body: ProxyResponse<T> = {};
    try {
        body = (await response.json()) as ProxyResponse<T>;
    } catch {
        // Non-JSON response; handled by the status check below.
    }

    if (!response.ok) {
        throw new GoogleCallError(
            body.message ?? `The ${operation} request failed (${response.status}).`,
            response.status,
            body.error ?? 'request_failed'
        );
    }

    return (body.result ?? {}) as T;
}

// ------------------------------------------------------------- connections

export interface ToolConnection {
    toolId: string;
    provider: string;
    connected: boolean;
    /** When the ACCESS token expires. A connection outlives this via refresh. */
    expiresAt: string | null;
    scopes: string[];
    connectedAt: string | null;
    updatedAt: string | null;
}

export interface ConnectionSnapshot {
    /** Whether the server has Google OAuth configured at all. */
    configured: boolean;
    supportedTools: string[];
    connections: ToolConnection[];
}

const EMPTY_SNAPSHOT: ConnectionSnapshot = {
    configured: false,
    supportedTools: [],
    connections: []
};

/**
 * Which tools are connected, according to the server.
 *
 * Returns an empty snapshot rather than throwing when the server is unreachable:
 * the UI's job in that case is to show everything as disconnected, not to break.
 */
export async function fetchConnections(): Promise<ConnectionSnapshot> {
    try {
        const response = await fetch(apiUrl('/api/oauth/connections'), {
            credentials: 'same-origin'
        });
        if (!response.ok) return EMPTY_SNAPSHOT;

        // The body is parsed JSON from the network. Each field is checked rather
        // than trusted, so an unexpected shape degrades to "nothing connected"
        // instead of throwing inside a React render.
        const body = (await response.json()) as Partial<ConnectionSnapshot> | null;
        return {
            configured: body?.configured === true,
            supportedTools: Array.isArray(body?.supportedTools) ? body.supportedTools : [],
            connections: Array.isArray(body?.connections) ? body.connections : []
        };
    } catch {
        return EMPTY_SNAPSHOT;
    }
}

/** Revoke the grant with Google and delete the stored credential. */
export async function disconnectTool(toolId: string): Promise<void> {
    const response = await fetch(apiUrl('/api/oauth/google/disconnect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ toolId })
    });

    if (!response.ok) {
        let message = `Could not disconnect ${toolId}.`;
        try {
            const body = (await response.json()) as ProxyResponse<never>;
            if (body.message) message = body.message;
        } catch {
            // Keep the generic message.
        }
        throw new GoogleCallError(message, response.status, 'disconnect_failed');
    }
}

// ------------------------------------------------------------------ connect

const POPUP_FEATURES = 'width=520,height=680,menubar=no,toolbar=no,location=yes';
/** Long enough for a consent screen including a fresh Google sign-in. */
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the connect flow in a popup and resolve when the server reports success.
 *
 * The popup navigates to OUR server, which redirects to Google and handles the
 * callback. The browser therefore never holds a code or a token — it only learns
 * whether the connection succeeded, via a postMessage from the completion page.
 */
export function connectTool(toolId: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const popup = window.open(
            apiUrl(`/api/oauth/google/start?toolId=${encodeURIComponent(toolId)}`),
            `autoagent-connect-${toolId}`,
            POPUP_FEATURES
        );

        if (!popup) {
            reject(
                new GoogleCallError(
                    'The browser blocked the connection window. Allow pop-ups for this site and try again.',
                    0,
                    'popup_blocked'
                )
            );
            return;
        }

        let settled = false;

        const cleanup = () => {
            window.removeEventListener('message', onMessage);
            clearInterval(closedPoll);
            clearTimeout(timeout);
        };

        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };

        const onMessage = (event: MessageEvent) => {
            // Only our own origin may report the outcome.
            if (event.origin !== window.location.origin) return;
            const data = event.data as { source?: string; ok?: boolean; reason?: string } | null;
            if (!data || data.source !== 'autoagent-oauth') return;

            if (data.ok) finish();
            else
                finish(
                    new GoogleCallError(
                        data.reason ?? 'The connection was not completed.',
                        0,
                        'connect_failed'
                    )
                );
        };

        window.addEventListener('message', onMessage);

        // If the user closes the window without finishing, stop waiting. The
        // message may still be in flight, so settle on the next tick.
        const closedPoll = setInterval(() => {
            if (!popup.closed) return;
            setTimeout(() => {
                finish(
                    new GoogleCallError(
                        'The connection window was closed before it finished.',
                        0,
                        'connect_cancelled'
                    )
                );
            }, 300);
        }, 500);

        const timeout = setTimeout(() => {
            finish(new GoogleCallError('The connection attempt timed out.', 0, 'connect_timeout'));
        }, CONNECT_TIMEOUT_MS);
    });
}
