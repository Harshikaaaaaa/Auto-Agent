import { Tool, ToolAction } from '../types';
import { registerTool } from '../toolRegistry';

const TOOL_ID = 'whatsapp';
const BRIDGE_URL = 'http://localhost:3234';

async function checkStatus(): Promise<{ status: string }> {
    try {
        const res = await fetch(`${BRIDGE_URL}/status`);
        return await res.json();
    } catch {
        return { status: 'offline' };
    }
}

// ==================== ACTIONS ====================

const sendMessage: ToolAction = {
    name: 'send_message',
    description: 'Send a WhatsApp message to a phone number (text or media)',
    inputKeys: ['to', 'text', 'mediaUrl', 'mediaType'],
    outputKeys: ['success', 'messageId'],
    execute: async (input) => {
        const to = input.to || input.phone;
        const text = input.text || input.message || input.body || ''; // Keeping aliases for backward compat
        const mediaUrl = input.mediaUrl;
        const mediaType = input.mediaType || 'image';

        if (!to || (!text && !mediaUrl)) return { error: 'Missing "to" and either "text" or "mediaUrl"' };

        try {
            const res = await fetch(`${BRIDGE_URL}/send`, {
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

const readMessages: ToolAction = {
    name: 'read_messages',
    description: 'Read recent messages from WhatsApp',
    inputKeys: ['count', 'jid'],
    outputKeys: ['messages'],
    execute: async (input) => {
        const count = input.count || 10;
        const jid = input.jid || '';

        try {
            const res = await fetch(`${BRIDGE_URL}/messages?count=${count}&jid=${jid}`);
            const data = await res.json();
            return { messages: data.messages };
        } catch {
            return { error: 'Failed to fetch messages' };
        }
    }
};

// ==================== REGISTRATION ====================

const whatsappTool: Tool = {
    id: TOOL_ID,
    name: 'WhatsApp',
    description: 'Send and receive WhatsApp messages via local bridge',
    icon: 'MessageCircle', // Lucide icon
    color: '#25D366',
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
                    const res = await fetch(`${BRIDGE_URL}/status`);
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
            await fetch(`${BRIDGE_URL}/disconnect`, { method: 'POST' });
        } catch {
            // Bridge already down: still clear the local connected flag below.
        }
        localStorage.removeItem('autoagent_whatsapp_connected');
    }
};

registerTool(whatsappTool);
