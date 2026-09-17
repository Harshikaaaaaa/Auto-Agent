import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTool } from '../toolRegistry';
import { mimeTypeFor, safeFileName } from '../connectors/files';
import '../connectors';

/**
 * The chain the reported prompt actually needs:
 *
 *   "create data scrape from website and save it summarize as markdown file
 *    and allow me to download"
 *
 * Fetch -> Extract -> Markdown -> Download. Before Task 7 none of these
 * capabilities existed, which is why the planner substituted Google Sheets.
 * This test runs the four real actions in sequence, passing state between them
 * exactly as the execution engine does.
 */

const SAMPLE_PAGE = `
<!doctype html>
<html>
  <head><title>Product Reviews</title></head>
  <body>
    <nav>Home | Shop | Cart</nav>
    <main>
      <h1>Product Reviews</h1>
      <p>The widget arrived quickly and works well.</p>
      <h2>Notable feedback</h2>
      <p>Several customers praised the battery life.</p>
      <a href="/reviews/page-2">Next page</a>
    </main>
    <script>window.analytics = true;</script>
    <footer>All rights reserved</footer>
  </body>
</html>`;

/** Run one registered action the way the engine would. */
async function runAction(toolId: string, actionName: string, input: Record<string, unknown>) {
  const action = getTool(toolId)?.actions.find((a) => a.name === actionName);
  if (!action) throw new Error(`${toolId}.${actionName} is not registered`);
  return action.execute(input);
}

describe('scrape to markdown download chain', () => {
  let clicked: Array<{ download: string; href: string }>;

  beforeEach(() => {
    clicked = [];

    // The fetch node calls the server, which is where the SSRF policy lives.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('/api/fetch')) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          return new Response(
            JSON.stringify({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body: SAMPLE_PAGE,
              bytes: SAMPLE_PAGE.length,
              finalUrl: body.url,
              redirects: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );

    // Patch only the blob helpers. Replacing the whole URL global would break
    // `new URL(...)`, which the extractor uses to resolve relative links.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock-url'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
  });

  it('turns a URL into a downloadable Markdown file', async () => {
    // ---- 1. Fetch ----
    const fetched = await runAction('web', 'fetch_page', {
      source_url: 'https://example.com/reviews',
    });

    expect(fetched.fetch_status).toBe(200);
    expect(String(fetched.raw_content)).toContain('Product Reviews');

    // ---- 2. Extract ----
    const extracted = await runAction('content', 'extract_content', {
      raw_content: fetched.raw_content,
      final_url: fetched.final_url,
    });

    expect(extracted.title).toBe('Product Reviews');
    expect(String(extracted.extracted_text)).toContain('arrived quickly');
    // Chrome and scripts were discarded.
    expect(String(extracted.extracted_text)).not.toContain('Home | Shop | Cart');
    expect(String(extracted.extracted_text)).not.toContain('window.analytics');
    // Relative links were resolved against the fetched URL.
    expect(extracted.links).toEqual([
      { text: 'Next page', href: 'https://example.com/reviews/page-2' },
    ]);

    // ---- 3. Markdown ----
    const formatted = await runAction('content', 'to_markdown', {
      title: extracted.title,
      extracted_text: extracted.extracted_text,
      final_url: fetched.final_url,
    });

    const markdown = String(formatted.markdown);
    expect(markdown).toContain('# Product Reviews');
    expect(markdown).toContain('> Source: https://example.com/reviews');
    expect(markdown).toContain('arrived quickly');
    expect(formatted.suggested_filename).toBe('product-reviews.md');

    // ---- 4. Download ----
    const downloaded = await runAction('files', 'download_file', {
      content: formatted.markdown,
      filename: formatted.suggested_filename,
    });

    expect(downloaded.downloaded).toBe(true);
    expect(downloaded.saved_filename).toBe('product-reviews.md');
    expect(downloaded.bytes).toBeGreaterThan(0);

    // A real download was triggered with the right name.
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('product-reviews.md');
  });

  it('reports a blocked fetch honestly instead of returning empty content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'fetch_blocked',
              reason: 'address_blocked',
              message: 'That address is on a private or reserved range.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    const result = await runAction('web', 'fetch_page', {
      source_url: 'http://169.254.169.254/latest/meta-data/',
    });

    // "Refused by policy" and "site is down" need different fixes, so the reason
    // has to reach the user.
    expect(result.raw_content).toBe('');
    expect(String(result.error)).toMatch(/private or reserved range/i);
  });

  it('reports a missing URL rather than fetching nothing', async () => {
    const result = await runAction('web', 'fetch_page', {});
    expect(String(result.error)).toMatch(/no source_url/i);
  });

  it('renders scraped records as a Markdown table', async () => {
    const formatted = await runAction('content', 'to_markdown', {
      title: 'Sentiment by product',
      records: [
        { product: 'Widget', sentiment: 'positive' },
        { product: 'Gadget', sentiment: 'negative' },
      ],
    });

    expect(String(formatted.markdown)).toContain('| product | sentiment |');
    expect(String(formatted.markdown)).toContain('| Widget | positive |');
  });

  it('refuses to download nothing', async () => {
    const result = await runAction('files', 'download_file', { content: '' });
    expect(result.downloaded).toBe(false);
    expect(String(result.error)).toMatch(/no content/i);
  });

  it('serialises non-string content rather than writing "[object Object]"', async () => {
    const result = await runAction('files', 'download_file', {
      content: { a: 1 },
      filename: 'data.json',
    });

    expect(result.downloaded).toBe(true);
    expect(result.saved_filename).toBe('data.json');
  });
});

describe('safeFileName', () => {
  it('keeps a sensible name', () => {
    expect(safeFileName('quarterly-report.md')).toBe('quarterly-report.md');
    expect(safeFileName('Notes.txt')).toBe('notes.txt');
  });

  it('neutralises path traversal in a suggested name', () => {
    // The name can come from model output or page content, so it is rebuilt
    // rather than trusted.
    expect(safeFileName('../../../etc/passwd')).toBe('passwd.md');
    expect(safeFileName('/etc/shadow')).toBe('shadow.md');
    expect(safeFileName('..\\..\\Windows\\System32\\config')).toBe('config.md');
  });

  it('forces a known extension', () => {
    expect(safeFileName('payload.exe')).toBe('payload.md');
    expect(safeFileName('script.sh')).toBe('script.md');
    expect(safeFileName('page.html')).toBe('page.html');
    expect(safeFileName('data.csv')).toBe('data.csv');
  });

  it('falls back for an unusable name', () => {
    expect(safeFileName('')).toBe('workflow-output.md');
    expect(safeFileName(undefined)).toBe('workflow-output.md');
    expect(safeFileName('///')).toBe('workflow-output.md');
  });
});

describe('mimeTypeFor', () => {
  it('maps known extensions', () => {
    expect(mimeTypeFor('a.md')).toBe('text/markdown');
    expect(mimeTypeFor('a.csv')).toBe('text/csv');
    expect(mimeTypeFor('a.json')).toBe('application/json');
  });

  it('defaults to plain text', () => {
    expect(mimeTypeFor('a.unknown')).toBe('text/plain');
  });
});
