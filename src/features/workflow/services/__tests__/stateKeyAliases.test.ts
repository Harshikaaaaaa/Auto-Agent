import { describe, expect, it } from 'vitest';
import { aliasesOf, resolveWithAliases, STATE_KEY_ALIAS_GROUPS } from '../stateKeyAliases';

describe('resolveWithAliases', () => {
  it('returns the exact key when present, ignoring aliases', () => {
    const state = { extracted_text: 'FULL', summary: 'SHORT' };
    // A node reading extracted_text gets exactly that, even though summary is a
    // sibling — an exact match always wins.
    expect(resolveWithAliases(state, 'extracted_text')).toBe('FULL');
  });

  it('falls back to a sibling alias when the exact key is absent', () => {
    // The bug this fixes: a Summarize node wrote `result`, a converter reads
    // `extracted_text`; they are synonyms, so the converter now gets the result.
    expect(resolveWithAliases({ result: 'SUMMARY' }, 'extracted_text')).toBe('SUMMARY');
    expect(resolveWithAliases({ summary: 'SUMMARY' }, 'extracted_text')).toBe('SUMMARY');
  });

  it('resolves url synonyms', () => {
    expect(resolveWithAliases({ url: 'http://x' }, 'source_url')).toBe('http://x');
    expect(resolveWithAliases({ source_url: 'http://x' }, 'url')).toBe('http://x');
  });

  it('returns undefined when neither the key nor any alias is present', () => {
    expect(resolveWithAliases({ unrelated: 1 }, 'extracted_text')).toBeUndefined();
  });

  it('does not treat unrelated keys as aliases', () => {
    // A recipient is not a body of text.
    expect(resolveWithAliases({ to: 'a@b.com' }, 'extracted_text')).toBeUndefined();
  });
});

describe('aliasesOf', () => {
  it('lists the other members of a key group', () => {
    expect(aliasesOf('summary')).toContain('extracted_text');
    expect(aliasesOf('summary')).toContain('result');
    // A key is never its own alias.
    expect(aliasesOf('summary')).not.toContain('summary');
  });

  it('returns empty for a key in no group', () => {
    expect(aliasesOf('some_bespoke_key')).toEqual([]);
  });

  it('keeps distinct concepts in separate groups', () => {
    // Guard against accidentally merging body text with a recipient or subject.
    const bodyGroup = STATE_KEY_ALIAS_GROUPS.find((g) => g.includes('extracted_text'))!;
    expect(bodyGroup).not.toContain('to');
    expect(bodyGroup).not.toContain('subject');
  });
});

describe('formatted list outputs resolve as body text', () => {
  it('connects a formatter output to a downstream reader of body text', () => {
    // The reported flow: "Format Email List" writes `formatted_emails`, and the
    // added download/email step reads `content`/`text`. They are one logical
    // value, so a consumer now receives the formatted list without a per-node
    // change.
    expect(resolveWithAliases({ formatted_emails: 'LIST' }, 'content')).toBe('LIST');
    expect(resolveWithAliases({ formatted_emails: 'LIST' }, 'text')).toBe('LIST');
    expect(resolveWithAliases({ formatted_text: 'LIST' }, 'body')).toBe('LIST');
  });
});
