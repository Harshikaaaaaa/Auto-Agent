import { beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITIES, type Capability } from '../types';
import {
  actionRequiresApproval,
  describeCatalog,
  findActionsByCapability,
  getActionSideEffect,
  getAllTools,
  getAvailableCapabilities,
  getExternalInputKeys,
  getTool,
  getToolStatuses,
  registerTool,
} from '../toolRegistry';
import '../connectors';

/**
 * Guards the capability metadata that the planner and the approval gate depend
 * on. A missing schema or a mis-classified side effect is not a cosmetic
 * problem: it either makes the planner hallucinate inputs, or it lets an
 * irreversible action run unattended.
 */

describe('capability metadata', () => {
  beforeAll(() => {
    // Importing the connectors barrel registers all five.
    expect(getAllTools().length).toBeGreaterThanOrEqual(5);
  });

  it('registers the expected connectors', () => {
    const ids = getAllTools()
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual([
      // Built-in capabilities, no credential needed.
      'content',
      'files',
      // External services.
      'gmail',
      'google_drive',
      'google_sheets',
      'slack',
      'web',
      'whatsapp',
    ]);
  });

  describe('every registered action', () => {
    const actions = getAllTools().flatMap((tool) =>
      tool.actions.map((action) => ({ toolId: tool.id, tool, action })),
    );

    it('declares input and output schemas', () => {
      for (const { toolId, action } of actions) {
        expect(action.inputSchema, `${toolId}.${action.name} inputSchema`).toBeDefined();
        expect(action.outputSchema, `${toolId}.${action.name} outputSchema`).toBeDefined();
        // An action with no outputs writes nothing to state and is useless.
        expect(
          Object.keys(action.outputSchema).length,
          `${toolId}.${action.name} must declare at least one output`,
        ).toBeGreaterThan(0);
      }
    });

    it('describes every field, so the planner is never guessing', () => {
      for (const { toolId, action } of actions) {
        for (const [name, field] of Object.entries({
          ...action.inputSchema,
          ...action.outputSchema,
        })) {
          expect(field.type, `${toolId}.${action.name}.${name} type`).toBeTruthy();
          expect(
            field.description?.length,
            `${toolId}.${action.name}.${name} needs a description`,
          ).toBeGreaterThan(0);
        }
      }
    });

    it('has key lists derived from its schemas, so they cannot drift', () => {
      for (const { toolId, action } of actions) {
        expect(action.inputKeys, `${toolId}.${action.name} inputKeys`).toEqual(
          Object.keys(action.inputSchema),
        );
        expect(action.outputKeys, `${toolId}.${action.name} outputKeys`).toEqual(
          Object.keys(action.outputSchema),
        );
      }
    });

    it('declares a side effect and an auth requirement', () => {
      for (const { toolId, action } of actions) {
        expect(
          ['read', 'write', 'irreversible'],
          `${toolId}.${action.name} sideEffect`,
        ).toContain(action.sideEffect);
        expect(typeof action.requiresAuth, `${toolId}.${action.name} requiresAuth`).toBe('boolean');
      }
    });

    it('declares only capabilities from the shared taxonomy', () => {
      for (const { toolId, action } of actions) {
        for (const capability of action.capabilities) {
          expect(CAPABILITIES, `${toolId}.${action.name} capability "${capability}"`).toContain(
            capability,
          );
        }
      }
    });

    it('declares cost hints somewhere, on the action or its tool', () => {
      for (const { tool, action } of actions) {
        const profile = action.costProfile ?? tool.costProfile;
        expect(profile, `${tool.id}.${action.name} cost profile`).toBeDefined();
        expect(profile?.reliability).toBeGreaterThanOrEqual(0);
        expect(profile?.reliability).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('side-effect classification', () => {
    it('classifies sends as irreversible', () => {
      // These cannot be undone once they happen.
      expect(getActionSideEffect('gmail', 'send_email')).toBe('irreversible');
      expect(getActionSideEffect('gmail', 'compose_and_send')).toBe('irreversible');
      expect(getActionSideEffect('slack', 'send_message')).toBe('irreversible');
      expect(getActionSideEffect('slack', 'format_and_send')).toBe('irreversible');
      expect(getActionSideEffect('whatsapp', 'send_message')).toBe('irreversible');
    });

    it('classifies reads as read', () => {
      expect(getActionSideEffect('gmail', 'read_inbox')).toBe('read');
      expect(getActionSideEffect('google_sheets', 'read_sheet')).toBe('read');
      expect(getActionSideEffect('google_drive', 'list_files')).toBe('read');
      expect(getActionSideEffect('google_drive', 'download_file')).toBe('read');
      expect(getActionSideEffect('whatsapp', 'read_messages')).toBe('read');
    });

    it('classifies correctable data changes as write', () => {
      expect(getActionSideEffect('google_sheets', 'write_sheet')).toBe('write');
      expect(getActionSideEffect('google_sheets', 'append_row')).toBe('write');
      expect(getActionSideEffect('google_drive', 'upload_file')).toBe('write');
    });
  });

  describe('approval derivation', () => {
    it('requires approval for every irreversible action', () => {
      for (const tool of getAllTools()) {
        for (const action of tool.actions) {
          if (action.sideEffect === 'irreversible') {
            expect(
              actionRequiresApproval(tool.id, action.name),
              `${tool.id}.${action.name} must require approval`,
            ).toBe(true);
          }
        }
      }
    });

    it('does not gate reads, which the old hardcoded tool list did', () => {
      // The previous implementation gated by tool id, so reading the inbox
      // prompted for approval while nothing new that actually sent was covered.
      expect(actionRequiresApproval('gmail', 'read_inbox')).toBe(false);
      expect(actionRequiresApproval('google_sheets', 'read_sheet')).toBe(false);
      expect(actionRequiresApproval('whatsapp', 'read_messages')).toBe(false);
    });

    it('does not gate correctable writes', () => {
      expect(actionRequiresApproval('google_sheets', 'append_row')).toBe(false);
      expect(actionRequiresApproval('google_drive', 'upload_file')).toBe(false);
    });

    it('returns false for an unknown tool or action rather than throwing', () => {
      expect(actionRequiresApproval('nope', 'send_email')).toBe(false);
      expect(actionRequiresApproval('gmail', 'nope')).toBe(false);
      expect(actionRequiresApproval(undefined, undefined)).toBe(false);
    });

    it('stays correct when a new irreversible connector is added', () => {
      // The point of deriving from classification: a new connector is gated
      // without anyone remembering to update a list.
      registerTool({
        id: 'test_pager',
        name: 'Test Pager',
        description: 'Pages an on-call engineer.',
        icon: 'Bell',
        color: '#000000',
        category: 'communication',
        scopes: [],
        costProfile: { latencyMs: 100, cost: 0, reliability: 7 },
        actions: [
          {
            name: 'page',
            description: 'Page the on-call engineer.',
            capabilities: ['chat.send'],
            sideEffect: 'irreversible',
            requiresAuth: false,
            inputSchema: { message: { type: 'string', description: 'What to say.', required: true } },
            outputSchema: { paged: { type: 'boolean', description: 'Whether it went out.' } },
            execute: async () => ({ paged: true }),
          },
        ],
        isAuthenticated: () => true,
        authenticate: async () => {},
        disconnect: () => {},
      });

      expect(actionRequiresApproval('test_pager', 'page')).toBe(true);
      // And its keys were derived without the connector declaring them. The
      // `error` output is added by the registry, so the failure channel exists
      // on every action whether or not a connector remembered to declare it.
      expect(getTool('test_pager')?.actions[0].inputKeys).toEqual(['message']);
      expect(getTool('test_pager')?.actions[0].outputKeys).toEqual(['paged', 'error']);
    });
  });

  describe('external inputs', () => {
    it('identifies values the user must supply', () => {
      // A spreadsheet id cannot be invented by an earlier step.
      expect(getExternalInputKeys('google_sheets', 'append_row')).toContain('spreadsheetId');
      expect(getExternalInputKeys('gmail', 'send_email')).toContain('to');
      expect(getExternalInputKeys('whatsapp', 'send_message')).toContain('to');
    });

    it('does not mark derivable values as external', () => {
      // A subject and body can come from an earlier summarisation step.
      const gmailExternal = getExternalInputKeys('gmail', 'send_email');
      expect(gmailExternal).not.toContain('subject');
      expect(gmailExternal).not.toContain('body');
    });
  });

  describe('capability lookup', () => {
    it('finds every action providing a capability', () => {
      const senders = findActionsByCapability('email.send');
      expect(senders.map((m) => m.action.name).sort()).toEqual(['compose_and_send', 'send_email']);
    });

    it('offers more than one provider for chat, enabling fallback', () => {
      // Task 12 uses this to route around a failing provider.
      const chatSenders = findActionsByCapability('chat.send');
      const toolIds = new Set(chatSenders.map((m) => m.toolId));
      expect(toolIds.size).toBeGreaterThan(1);
    });

    it('orders providers by reliability, best first', () => {
      const chatSenders = findActionsByCapability('chat.send');
      const reliabilities = chatSenders.map(
        (m) => (m.action.costProfile ?? getTool(m.toolId)?.costProfile)?.reliability ?? 0,
      );
      const sorted = [...reliabilities].sort((a, b) => b - a);
      expect(reliabilities).toEqual(sorted);
      // Slack (8) must rank above WhatsApp (5), which is an unofficial client.
      const slackIndex = chatSenders.findIndex((m) => m.toolId === 'slack');
      const whatsappIndex = chatSenders.findIndex((m) => m.toolId === 'whatsapp');
      expect(slackIndex).toBeLessThan(whatsappIndex);
    });

    it('resolves the capabilities added in Task 7', () => {
      // These were deliberately unprovided until the built-in nodes existed.
      expect(findActionsByCapability('web.fetch').map((m) => m.toolId)).toEqual(['web']);
      expect(findActionsByCapability('content.extract').map((m) => m.toolId)).toEqual(['content']);
      expect(findActionsByCapability('file.deliver').map((m) => m.toolId)).toEqual(['files']);
    });

    it('returns nothing for a capability no tool provides', () => {
      // Not in the taxonomy at all, so nothing can claim it.
      expect(findActionsByCapability('not.a.capability' as never)).toEqual([]);
    });

    it('reports the capabilities that are actually available', () => {
      const available = getAvailableCapabilities();
      expect(available).toContain('email.send');
      expect(available).toContain('spreadsheet.write');
      // The scrape-to-download chain is now fully covered.
      expect(available).toContain('web.fetch');
      expect(available).toContain('content.extract');
      expect(available).toContain('content.format');
      expect(available).toContain('file.deliver');
    });
  });

  describe('describeCatalog', () => {
    const catalog = describeCatalog();

    it('describes every registered tool', () => {
      expect(catalog.map((t) => t.id)).toEqual(expect.arrayContaining(['gmail', 'slack']));
    });

    it('is JSON-serialisable, since it is sent over the wire', () => {
      expect(() => JSON.stringify(catalog)).not.toThrow();
      expect(JSON.parse(JSON.stringify(catalog))).toEqual(JSON.parse(JSON.stringify(catalog)));
    });

    it('exposes the safety class and approval flag per action', () => {
      const gmail = catalog.find((t) => t.id === 'gmail');
      const send = gmail?.actions.find((a) => a.name === 'send_email');

      expect(send?.sideEffect).toBe('irreversible');
      expect(send?.requiresApproval).toBe(true);
      expect(send?.requiresAuth).toBe(true);
    });

    it('marks external inputs so the planner asks the user for them', () => {
      const sheets = catalog.find((t) => t.id === 'google_sheets');
      const append = sheets?.actions.find((a) => a.name === 'append_row');
      const spreadsheetId = append?.inputs.find((f) => f.name === 'spreadsheetId');

      expect(spreadsheetId?.external).toBe(true);
      expect(spreadsheetId?.required).toBe(true);
    });

    it('omits cost hints, which are for routing rather than planning', () => {
      const serialized = JSON.stringify(catalog);
      expect(serialized).not.toContain('costProfile');
      expect(serialized).not.toContain('latencyMs');
    });

    it('keeps a stable shape', () => {
      // Snapshot of the SHAPE rather than the content, so adding a connector
      // does not fail the test but removing a field does.
      const gmail = catalog.find((t) => t.id === 'gmail');
      expect(Object.keys(gmail ?? {}).sort()).toEqual([
        'actions',
        'authenticated',
        'capabilities',
        'category',
        'description',
        'id',
        'name',
      ]);
      expect(Object.keys(gmail?.actions[0] ?? {}).sort()).toEqual([
        'capabilities',
        'description',
        'inputKeys',
        'inputs',
        'name',
        'outputKeys',
        'outputs',
        'requiresApproval',
        'requiresAuth',
        'sideEffect',
      ]);
    });
  });

  describe('getToolStatuses', () => {
    it('surfaces category, capabilities and approval for the UI', () => {
      const statuses = getToolStatuses();
      const gmail = statuses.find((t) => t.id === 'gmail');

      expect(gmail?.category).toBe('communication');
      expect(gmail?.capabilities).toContain('email.send');
      const send = gmail?.actions.find((a) => a.name === 'send_email');
      expect(send?.requiresApproval).toBe(true);
      expect(send?.sideEffect).toBe('irreversible');
    });
  });

  describe('taxonomy', () => {
    it('has no duplicate entries', () => {
      expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    });

    it('uses a domain.verb naming shape throughout', () => {
      for (const capability of CAPABILITIES as readonly Capability[]) {
        expect(capability, `capability "${capability}"`).toMatch(/^[a-z]+\.[a-z]+$/);
      }
    });
  });
});
