import { Tool, ToolAction } from '../types';
import { registerTool } from '../toolRegistry';

const TOOL_ID = 'slack';
const WEBHOOK_KEY = 'autoagent_slack_webhook';

function getWebhookUrl(): string | null {
    return localStorage.getItem(WEBHOOK_KEY);
}
function isAvailable(): boolean {
    return !!getWebhookUrl();
}

// ==================== ACTIONS ====================

const sendMessage: ToolAction = {
    name: 'send_message',
    description: 'Send a message to a Slack channel via webhook',
    inputKeys: ['text', 'channel', 'username'],
    outputKeys: ['success', 'message'],
    execute: async (input) => {
        const url = getWebhookUrl();
        if (!url) return { error: 'Slack webhook not configured. Set it up in tool settings.' };
        const text = input.text || input.message || '(empty message)';
        const payload: any = { text };
        if (input.channel) payload.channel = input.channel;
        if (input.username) payload.username = input.username;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) return { error: `Slack webhook failed (${res.status}): ${await res.text()}` };
        return { success: true, message: text };
    }
};

const formatAndSend: ToolAction = {
    name: 'format_and_send',
    description: 'Format data into a rich Slack message with blocks and send it',
    inputKeys: ['title', 'body', 'fields', 'channel'],
    outputKeys: ['success', 'title', 'fieldsCount'],
    execute: async (input) => {
        const url = getWebhookUrl();
        if (!url) return { error: 'Slack webhook not configured' };
        const title = input.title || 'Notification';
        const body = input.body || input.text || '';
        const fields = input.fields || {};
        const blocks: any[] = [
            { type: 'header', text: { type: 'plain_text', text: title } },
            { type: 'section', text: { type: 'mrkdwn', text: body } }
        ];
        const fieldEntries = Object.entries(fields);
        if (fieldEntries.length > 0) {
            blocks.push({ type: 'section', fields: fieldEntries.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:*\n${v}` })) });
        }
        blocks.push({ type: 'divider' });
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_Sent by AutoAgent at ${new Date().toISOString()}_` }] });
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks }) });
        if (!res.ok) return { error: `Slack send failed (${res.status}): ${await res.text()}` };
        return { success: true, title, fieldsCount: fieldEntries.length };
    }
};

// ==================== REGISTRATION ====================

const slackTool: Tool = {
    id: TOOL_ID,
    name: 'Slack',
    description: 'Send messages and rich notifications to Slack channels',
    icon: 'Hash',
    color: '#E01E5A',
    scopes: [],
    actions: [sendMessage, formatAndSend],
    isAuthenticated: isAvailable,
    authenticate: async () => {
        const url = prompt('Enter your Slack Incoming Webhook URL:');
        if (!url || !url.startsWith('https://hooks.slack.com/')) {
            throw new Error('Invalid Slack webhook URL. It should start with https://hooks.slack.com/');
        }
        localStorage.setItem(WEBHOOK_KEY, url);
    },
    disconnect: () => { localStorage.removeItem(WEBHOOK_KEY); }
};

registerTool(slackTool);
