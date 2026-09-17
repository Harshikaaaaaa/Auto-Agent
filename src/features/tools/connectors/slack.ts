import { ToolActionDefinition, ToolDefinition } from '../types';
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

const sendMessage: ToolActionDefinition = {
  name: 'send_message',
  description: 'Post a plain message to a Slack channel via an incoming webhook.',
  capabilities: ['chat.send'],
  // A posted message cannot be unposted, so this always needs approval.
  sideEffect: 'irreversible',
  requiresAuth: true,
  costProfile: { latencyMs: 400, cost: 0, reliability: 8 },
  inputSchema: {
    text: { type: 'string', description: 'Message body.', required: true },
    channel: {
      type: 'string',
      description: 'Channel override, for example "#alerts". Defaults to the webhook channel.',
      external: true,
    },
    username: { type: 'string', description: 'Display name to post as.' },
  },
  outputSchema: {
    success: { type: 'boolean', description: 'Whether Slack accepted the message.' },
    message: { type: 'string', description: 'The text that was posted.' },
  },
  execute: async (input) => {
    const url = getWebhookUrl();
    if (!url) return { error: 'Slack webhook not configured. Set it up in tool settings.' };
    const text = input.text || input.message || '(empty message)';
    const payload: any = { text };
    if (input.channel) payload.channel = input.channel;
    if (input.username) payload.username = input.username;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { error: `Slack webhook failed (${res.status}): ${await res.text()}` };
    return { success: true, message: text };
  },
};

const formatAndSend: ToolActionDefinition = {
  name: 'format_and_send',
  description: 'Post a formatted Slack message with a header, body and field list.',
  capabilities: ['chat.send', 'content.format'],
  sideEffect: 'irreversible',
  requiresAuth: true,
  costProfile: { latencyMs: 450, cost: 0, reliability: 8 },
  inputSchema: {
    title: { type: 'string', description: 'Header line of the message.' },
    body: { type: 'string', description: 'Main body, Slack markdown.', format: 'markdown' },
    fields: { type: 'object', description: 'Label to value pairs rendered as a field grid.' },
    channel: { type: 'string', description: 'Channel override.', external: true },
  },
  outputSchema: {
    success: { type: 'boolean', description: 'Whether Slack accepted the message.' },
    title: { type: 'string', description: 'Header that was posted.' },
    fieldsCount: { type: 'number', description: 'How many fields were rendered.' },
  },
  execute: async (input) => {
    const url = getWebhookUrl();
    if (!url) return { error: 'Slack webhook not configured' };
    const title = input.title || 'Notification';
    const body = input.body || input.text || '';
    const fields = input.fields || {};
    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: title } },
      { type: 'section', text: { type: 'mrkdwn', text: body } },
    ];
    const fieldEntries = Object.entries(fields);
    if (fieldEntries.length > 0) {
      blocks.push({
        type: 'section',
        fields: fieldEntries.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:*\n${v}` })),
      });
    }
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Sent by AutoAgent at ${new Date().toISOString()}_` }],
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
    if (!res.ok) return { error: `Slack send failed (${res.status}): ${await res.text()}` };
    return { success: true, title, fieldsCount: fieldEntries.length };
  },
};

// ==================== REGISTRATION ====================

const slackTool: ToolDefinition = {
  id: TOOL_ID,
  name: 'Slack',
  description: 'Post messages and formatted notifications to Slack channels.',
  icon: 'Hash',
  color: '#E01E5A',
  category: 'communication',
  costProfile: { latencyMs: 400, cost: 0, reliability: 8 },
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
  disconnect: () => {
    localStorage.removeItem(WEBHOOK_KEY);
  },
};

registerTool(slackTool);
