import { describe, expect, it } from 'vitest';
import { suggestFixes } from '../failureFixes';

/**
 * Post-failure fix suggestions. The contract: a SHORT, targeted list for the
 * actual failure (not one catch-all, not a single option), always ending with a
 * "write my own" custom option so the user is never boxed in.
 */
describe('suggestFixes', () => {
  it('always ends with a custom "write my own" option', () => {
    for (const kind of [
      'auth',
      'invalid_input',
      'unsupported',
      'rate_limit',
      'transient',
      'permanent',
      undefined,
    ] as const) {
      const fixes = suggestFixes({ node: 'Some Step', failureKind: kind });
      expect(fixes.length).toBeGreaterThan(0);
      expect(fixes[fixes.length - 1].kind).toBe('custom');
    }
  });

  it('offers to reconnect on an auth failure', () => {
    const fixes = suggestFixes({ node: 'Send Email', failureKind: 'auth' });
    expect(fixes.some((f) => f.kind === 'reconnect')).toBe(true);
  });

  it('offers to change the value on invalid input', () => {
    const fixes = suggestFixes({ node: 'Append Row', failureKind: 'invalid_input' });
    expect(fixes.some((f) => f.kind === 'change_input')).toBe(true);
  });

  it('offers the browser-render fix for an empty web page', () => {
    const fixes = suggestFixes({
      node: 'Fetch Webpage',
      failureKind: 'invalid_input',
      output: 'There was no content to download.',
    });
    const render = fixes.find((f) => f.prompt?.includes('render_mode'));
    expect(render).toBeDefined();
    // The canned prompt targets THAT node by name and touches nothing else.
    expect(render?.prompt).toContain('"Fetch Webpage"');
    expect(render?.prompt).toContain('Do not change any other node');
  });

  it('suggests swapping in each alternative tool for an unsupported step', () => {
    const fixes = suggestFixes({
      node: 'Text Customer',
      failureKind: 'unsupported',
      alternatives: ['slack.send_message', 'whatsapp.send_message'],
    });
    const patches = fixes.filter((f) => f.kind === 'patch');
    expect(patches.length).toBeGreaterThanOrEqual(1);
    expect(patches[0].prompt).toContain('slack');
    expect(patches[0].prompt).toContain('send_message');
  });

  it('offers to remove an unsupported step when nothing else can do it', () => {
    const fixes = suggestFixes({ node: 'Text Customer', failureKind: 'unsupported' });
    const remove = fixes.find((f) => f.prompt?.toLowerCase().includes('remove'));
    expect(remove).toBeDefined();
  });

  it('offers a plain re-run for a throttle or a transient failure', () => {
    for (const kind of ['rate_limit', 'transient'] as const) {
      const fixes = suggestFixes({ node: 'Fetch Webpage', failureKind: kind });
      expect(fixes.some((f) => f.kind === 'retry')).toBe(true);
    }
  });

  it('caps the targeted options at three (plus the custom one)', () => {
    const fixes = suggestFixes({
      node: 'Do Thing',
      failureKind: 'unsupported',
      alternatives: ['a.x', 'b.y', 'c.z', 'd.w', 'e.v'],
    });
    const targeted = fixes.filter((f) => f.kind !== 'custom');
    expect(targeted.length).toBeLessThanOrEqual(3);
  });

  it('names the failing node in every suggestion detail', () => {
    const fixes = suggestFixes({ node: 'Fetch Webpage', failureKind: 'auth' });
    // The reconnect suggestion should reference the node so the user knows which.
    expect(fixes[0].detail).toContain('Fetch Webpage');
  });
});
