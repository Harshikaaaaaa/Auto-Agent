import { ToolActionDefinition, ToolDefinition } from '../types';
import { registerTool } from '../toolRegistry';
import { apiUrl } from '@config/api';

const TOOL_ID = 'whatsapp';
// Same-origin in production; the Vite dev proxy forwards to the API in dev.
// Previously hardcoded to localhost:3234, which broke any real deployment.
const BRIDGE_URL = apiUrl('');

/**
 * Call the bridge with the session cookie attached.
 *
 * The bridge routes require a session, so a bare `fetch` would 401 on every
 * call and the connector would look permanently offline.
 */
function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${BRIDGE_URL}${path}`, { credentials: 'same-origin', ...init });
}

async function checkStatus(): Promise<{ status: string }> {
    try {
        const res = await bridgeFetch('/status');
        return await res.json();
    } catch {
        return { status: 'offline' };
    }
}

// ==================== ACTIONS ====================

const sendMessage: ToolActionDefinition = {
    name: 'send_message',
    description: 'Send a WhatsApp message to a phone number, with optional media.',
    capabilities: ['chat.send'],
    // A delivered WhatsApp message cannot be recalled.
    sideEffect: 'irreversible',
    requiresAuth: true,
    costProfile: { latencyMs: 1500, cost: 0, reliability: 5 },
    inputSchema: {
        to: {
            type: 'string',
            description: 'Destination phone number in international format.',
            required: true,
            external: true,
            format: 'phone'
        },
        text: { type: 'string', description: 'Message body, or the media caption.' },
        mediaUrl: {
            type: 'string',
            description: 'Public http(s) URL of media to attach. Local paths are rejected.',
            format: 'url'
        },
        mediaType: {
            type: 'string',
            description: 'Kind of media being sent.',
            enum: ['image', 'video', 'audio', 'document']
        }
    },
    outputSchema: {
        success: { type: 'boolean', description: 'Whether the bridge accepted the message.' },
        messageId: { type: 'string', description: 'Identifier of the sent message.' }
    },
    execute: async (input) => {
        const to = input.to || input.phone;
        const text = input.text || input.message || input.body || ''; // Keeping aliases for backward compat
        const mediaUrl = input.mediaUrl;
        const mediaType = input.mediaType || 'image';

        if (!to || (!text && !mediaUrl)) return { error: 'Missing "to" and either "text" or "mediaUrl"' };

        try {
            const res = await bridgeFetch('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to, text, mediaUrl, mediaType })
            });
            const data = await res.json();
            if (!res.ok) return { error: data.error };
            return { success: true, to: data.to };
        } catch (_e) {
            return { error: 'Failed to contact WhatsApp bridge' };
        }
    }
};

const readMessages: ToolActionDefinition = {
    name: 'read_messages',
    description: 'Read recent WhatsApp messages seen by the bridge.',
    capabilities: ['chat.read'],
    sideEffect: 'read',
    requiresAuth: true,
    costProfile: { latencyMs: 500, cost: 0, reliability: 5 },
    inputSchema: {
        count: { type: 'number', description: 'How many messages to return.' },
        jid: { type: 'string', description: 'Limit to one conversation id.' }
    },
    outputSchema: {
        messages: {
            type: 'array',
            description: 'Recent messages.',
            items: { type: 'object', description: 'One message with from, text and timestamp.' }
        }
    },
    execute: async (input) => {
        const count = input.count || 10;
        const jid = input.jid || '';

        try {
            const res = await bridgeFetch(`/messages?count=${count}&jid=${jid}`);
            const data = await res.json();
            return { messages: data.messages };
        } catch {
            return { error: 'Failed to fetch messages' };
        }
    }
};

// ==================== REGISTRATION ====================

const whatsappTool: ToolDefinition = {
    id: TOOL_ID,
    name: 'WhatsApp',
    description: 'Send and receive WhatsApp messages through the local bridge.',
    icon: 'MessageCircle', // Lucide icon
    color: '#25D366',
    category: 'messaging',
    // Lowest reliability of the connectors: an unofficial client on a single
    // stateful session that reconnects often. See Task 17.
    costProfile: { latencyMs: 1500, cost: 0, reliability: 5 },
    scopes: [],
    actions: [sendMessage, readMessages],

    // We check availability by pinging the bridge status
    // Note: This is async but the interface is sync. 
    // We'll rely on a flag stored in localStorage for immediate UI feedback, 
    // but the true connect happens via the bridge.
    isAuthenticated: () => {
        return localStorage.getItem('autoagent_whatsapp_connected') === 'true';
    },

    authenticate: async () => {
        // Check bridge is running
        const status = await checkStatus();
        if (status.status === 'offline') {
            alert('WhatsApp Bridge server is offline. Run "npm run whatsapp" in terminal.');
            return;
        }

        if (status.status === 'connected') {
            localStorage.setItem('autoagent_whatsapp_connected', 'true');
            alert('Already connected!');
            return;
        }

        // Open QR page in new tab/window
        const qrWindow = window.open(`${BRIDGE_URL}/qr`, 'WA_Auth', 'width=500,height=600');
        
        if (!qrWindow) {
            alert('Please allow popups and try again.');
            return;
        }

        // Poll for connection success
        return new Promise<void>((resolve) => {
            const pollInterval = setInterval(async () => {
                try {
                    const res = await bridgeFetch('/status');
                    const data = await res.json();
                    if (data.status === 'connected') {
                        localStorage.setItem('autoagent_whatsapp_connected', 'true');
                        clearInterval(pollInterval);
                        qrWindow.close();
                        alert('WhatsApp connected successfully!');
                        resolve();
                    }
                } catch {
                    // Bridge not reachable yet; keep polling until the timeout below.
                }
            }, 2000);

            // Stop polling after 2 minutes
            setTimeout(() => {
                clearInterval(pollInterval);
                resolve();
            }, 120000);
        });
    },

    disconnect: async () => {
        try {
            await bridgeFetch('/disconnect', { method: 'POST' });
        } catch {
            // Bridge already down: still clear the local connected flag below.
        }
        localStorage.removeItem('autoagent_whatsapp_connected');
    }
};

registerTool(whatsappTool);
