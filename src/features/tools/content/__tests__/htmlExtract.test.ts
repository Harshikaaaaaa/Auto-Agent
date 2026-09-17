import { describe, expect, it } from 'vitest';
import { extractFromHtml, toFileNameStem, toMarkdown } from '../htmlExtract';

/**
 * HTML extraction and Markdown rendering.
 *
 * Fetched HTML is untrusted input, so these tests cover hostile and malformed
 * markup as well as ordinary pages.
 */

describe('extractFromHtml', () => {
  it('pulls out the title, text, outline and links', () => {
    const html = `
      <html>
        <head><title>Quarterly Report</title></head>
        <body>
          <main>
            <h1>Quarterly Report</h1>
            <p>Revenue grew by 12 percent.</p>
            <h2>Regions</h2>
            <p>EMEA led the quarter.</p>
            <a href="/details">Full details</a>
          </main>
        </body>
      </html>`;

    const result = extractFromHtml(html, 'https://example.com/reports/q1');

    expect(result.title).toBe('Quarterly Report');
    expect(result.text).toContain('Revenue grew by 12 percent.');
    expect(result.text).toContain('EMEA led the quarter.');
    expect(result.headings).toEqual([
      { level: 1, text: 'Quarterly Report' },
      { level: 2, text: 'Regions' },
    ]);
    // Relative links are resolved against the page URL.
    expect(result.links).toEqual([{ text: 'Full details', href: 'https://example.com/details' }]);
  });

  it('discards scripts, styles and page chrome', () => {
    const html = `
      <html><head><title>T</title><style>.a{color:red}</style></head>
      <body>
        <nav>Home About Contact</nav>
        <header>Site banner</header>
        <main><p>The actual article body.</p></main>
        <footer>Copyright notice</footer>
        <script>window.tracked = true;</script>
      </body></html>`;

    const result = extractFromHtml(html);

    expect(result.text).toContain('The actual article body.');
    // None of the chrome should dominate the extracted content.
    expect(result.text).not.toContain('window.tracked');
    expect(result.text).not.toContain('color:red');
    expect(result.text).not.toContain('Home About Contact');
    expect(result.text).not.toContain('Copyright notice');
  });

  it('never executes script content, only reads text', () => {
    // DOMParser produces an inert document: no scripts run, no subresources load.
    const html = `<html><body><img src="x" onerror="globalThis.__pwned = true"><script>globalThis.__pwned2 = true</script><p>safe</p></body></html>`;

    const result = extractFromHtml(html);

    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect((globalThis as Record<string, unknown>).__pwned2).toBeUndefined();
    expect(result.text).toContain('safe');
  });

  it('falls back to h1 when there is no title element', () => {
    const result = extractFromHtml('<html><body><h1>Fallback Heading</h1></body></html>');
    expect(result.title).toBe('Fallback Heading');
  });

  it('prefers the main region over the whole body', () => {
    const html = `
      <body>
        <div>Sidebar clutter that should not win</div>
        <article><p>The real content.</p></article>
      </body>`;

    const result = extractFromHtml(html);
    expect(result.text).toBe('The real content.');
  });

  it('skips anchors that are not navigable', () => {
    const html = `<body>
      <a href="#section">Jump</a>
      <a href="javascript:alert(1)">Bad</a>
      <a href="https://example.com/good">Good</a>
    </body>`;

    const result = extractFromHtml(html);
    expect(result.links).toEqual([{ text: 'Good', href: 'https://example.com/good' }]);
  });

  it('de-duplicates repeated links', () => {
    const html = `<body>
      <a href="https://example.com/a">One</a>
      <a href="https://example.com/a">One again</a>
    </body>`;

    expect(extractFromHtml(html).links).toHaveLength(1);
  });

  it('collapses runs of spaces but keeps a line break', () => {
    // Horizontal runs collapse to one space; a newline is kept because it
    // carries paragraph structure that makes the extracted text readable.
    const result = extractFromHtml('<body><p>Lots     of\n\n\n   space</p></body>').text;

    expect(result).toBe('Lots of\nspace');
    expect(result).not.toMatch(/ {2}/);
    expect(result).not.toMatch(/\n{2,}/);
  });

  it('handles malformed markup the way a browser would', () => {
    const html = '<body><p>Unclosed paragraph<div>Nested oddly</body>';
    const result = extractFromHtml(html);
    expect(result.text).toContain('Unclosed paragraph');
    expect(result.text).toContain('Nested oddly');
  });

  it('returns empty results for empty input rather than throwing', () => {
    expect(extractFromHtml('')).toEqual({ title: '', text: '', headings: [], links: [] });
    expect(extractFromHtml('   ')).toEqual({ title: '', text: '', headings: [], links: [] });
  });

  it('treats plain text input as its own content', () => {
    const result = extractFromHtml('Just a sentence with no markup.');
    expect(result.text).toContain('Just a sentence with no markup.');
  });
});

describe('toMarkdown', () => {
  it('renders a title, source and body', () => {
    const markdown = toMarkdown({
      title: 'Weekly Digest',
      text: 'Three things happened.',
      sourceUrl: 'https://example.com/digest',
    });

    expect(markdown).toContain('# Weekly Digest');
    expect(markdown).toContain('> Source: https://example.com/digest');
    expect(markdown).toContain('Three things happened.');
  });

  it('renders records as a table using the union of keys', () => {
    const markdown = toMarkdown({
      title: 'Reviews',
      records: [
        { product: 'Widget', sentiment: 'positive' },
        { product: 'Gadget', score: 4 },
      ],
    });

    expect(markdown).toContain('| product | sentiment | score |');
    expect(markdown).toContain('| --- | --- | --- |');
    expect(markdown).toContain('| Widget | positive |  |');
    expect(markdown).toContain('| Gadget |  | 4 |');
  });

  it('escapes pipes so a cell cannot break the table', () => {
    const markdown = toMarkdown({ records: [{ note: 'a | b' }] });
    expect(markdown).toContain('a \\| b');
  });

  it('flattens newlines inside a cell', () => {
    const markdown = toMarkdown({ records: [{ note: 'line one\nline two' }] });
    expect(markdown).toContain('| line one line two |');
  });

  it('renders the outline only when there is no body text', () => {
    const withText = toMarkdown({
      text: 'Body wins.',
      headings: [{ level: 2, text: 'Ignored' }],
    });
    expect(withText).not.toContain('## Ignored');

    const withoutText = toMarkdown({ headings: [{ level: 2, text: 'Used' }] });
    expect(withoutText).toContain('## Used');
  });

  it('clamps heading levels to valid Markdown', () => {
    const markdown = toMarkdown({ headings: [{ level: 9, text: 'Deep' }] });
    expect(markdown).toContain('###### Deep');
  });

  it('omits links unless asked', () => {
    const links = [{ text: 'Docs', href: 'https://example.com/docs' }];

    expect(toMarkdown({ text: 'x', links })).not.toContain('## Links');
    expect(toMarkdown({ text: 'x', links, includeLinks: true })).toContain(
      '- [Docs](https://example.com/docs)',
    );
  });

  it('produces an empty string when there is nothing to render', () => {
    expect(toMarkdown({})).toBe('');
  });

  it('does not leave runs of blank lines', () => {
    const markdown = toMarkdown({ title: 'T', text: 'a\n\n\n\n\nb' });
    expect(markdown).not.toMatch(/\n{3,}/);
  });
});

describe('toFileNameStem', () => {
  it('slugifies a title', () => {
    expect(toFileNameStem('Quarterly Report 2026!')).toBe('quarterly-report-2026');
  });

  it('strips path separators so a title cannot steer the write location', () => {
    // A model-generated or page-derived title is untrusted input.
    expect(toFileNameStem('../../etc/passwd')).toBe('etc-passwd');
    expect(toFileNameStem('/absolute/path')).toBe('absolute-path');
    expect(toFileNameStem('..\\..\\windows')).toBe('windows');
  });

  it('falls back when nothing usable remains', () => {
    expect(toFileNameStem('')).toBe('workflow-output');
    expect(toFileNameStem('...')).toBe('workflow-output');
    expect(toFileNameStem('   ', 'custom')).toBe('custom');
  });

  it('caps the length', () => {
    expect(toFileNameStem('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
