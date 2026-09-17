/**
 * HTML to readable content, and content to Markdown.
 *
 * Kept as pure functions, separate from the connector, so the parsing rules are
 * unit-testable without a workflow around them.
 *
 * Uses the platform DOMParser rather than a parsing dependency: it is available
 * in the browser and in the jsdom test environment, and it handles malformed
 * markup the way a browser does.
 *
 * SECURITY: fetched HTML is untrusted. Parsing happens via DOMParser into an
 * inert document, which does not execute scripts or load subresources, and only
 * text is ever read out of it. Nothing here is inserted into the live DOM.
 */

export interface ExtractedHeading {
  level: number;
  text: string;
}

export interface ExtractedLink {
  text: string;
  href: string;
}

export interface ExtractedContent {
  title: string;
  text: string;
  headings: ExtractedHeading[];
  links: ExtractedLink[];
}

/** Elements whose text is never part of the readable content. */
const NON_CONTENT_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
];

/** Collapse whitespace the way a reader perceives it. */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Collapse runs of blank lines to at most one. */
function collapseBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n');
}

function parseDocument(html: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

/**
 * Strip tags without a DOM.
 * Fallback for a non-browser context; the DOM path is preferred because it
 * understands entities and malformed markup.
 */
function stripTags(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

/**
 * Pull readable content out of an HTML document.
 *
 * @param html     Raw HTML.
 * @param baseUrl  Used to resolve relative links to absolute ones.
 */
export function extractFromHtml(html: string, baseUrl?: string): ExtractedContent {
  const source = String(html ?? '');

  if (source.trim().length === 0) {
    return { title: '', text: '', headings: [], links: [] };
  }

  const doc = parseDocument(source);

  if (!doc) {
    return { title: '', text: collapseBlankLines(stripTags(source)), headings: [], links: [] };
  }

  // Remove chrome before reading text, so navigation and cookie banners do not
  // dominate the extracted content.
  for (const selector of NON_CONTENT_SELECTORS) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      element.remove();
    }
  }

  const title = normalizeWhitespace(
    doc.querySelector('title')?.textContent ??
      doc.querySelector('h1')?.textContent ??
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
      '',
  );

  const headings: ExtractedHeading[] = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: normalizeWhitespace(element.textContent ?? ''),
    }))
    .filter((heading) => heading.text.length > 0);

  const links: ExtractedLink[] = [];
  const seenHrefs = new Set<string>();
  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const rawHref = anchor.getAttribute('href') ?? '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;

    let href = rawHref;
    if (baseUrl) {
      try {
        href = new URL(rawHref, baseUrl).href;
      } catch {
        // Keep the raw value when it cannot be resolved.
      }
    }
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    links.push({ text: normalizeWhitespace(anchor.textContent ?? ''), href });
  }

  // Prefer the main content region when the page marks one.
  const contentRoot =
    doc.querySelector('main') ??
    doc.querySelector('article') ??
    doc.querySelector('[role="main"]') ??
    doc.body;

  const text = collapseBlankLines(normalizeWhitespace(contentRoot?.textContent ?? ''));

  return { title, text, headings, links };
}

export interface MarkdownInput {
  title?: string;
  text?: string;
  headings?: ExtractedHeading[];
  links?: ExtractedLink[];
  /** Tabular data rendered as a Markdown table. */
  records?: Array<Record<string, unknown>>;
  sourceUrl?: string;
  /** Include a "Links" section. Off by default: it is usually noise. */
  includeLinks?: boolean;
}

function escapeTableCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

/** Render an array of objects as a Markdown table, using the union of keys. */
function renderTable(records: Array<Record<string, unknown>>): string {
  const columns = Array.from(new Set(records.flatMap((record) => Object.keys(record ?? {}))));
  if (columns.length === 0) return '';

  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const rows = records.map(
    (record) => `| ${columns.map((column) => escapeTableCell(record?.[column])).join(' | ')} |`,
  );

  return [header, divider, ...rows].join('\n');
}

/** Compose a Markdown document from extracted content. */
export function toMarkdown(input: MarkdownInput): string {
  const sections: string[] = [];

  const title = (input.title ?? '').trim();
  if (title) sections.push(`# ${title}`);

  if (input.sourceUrl) sections.push(`> Source: ${input.sourceUrl}`);

  if (Array.isArray(input.records) && input.records.length > 0) {
    const table = renderTable(input.records);
    if (table) sections.push(table);
  }

  const text = (input.text ?? '').trim();
  if (text) sections.push(text);

  // Headings only earn their place when there is no body text to structure.
  if (!text && Array.isArray(input.headings) && input.headings.length > 0) {
    sections.push(
      input.headings
        .map((heading) => `${'#'.repeat(Math.min(Math.max(heading.level, 1), 6))} ${heading.text}`)
        .join('\n\n'),
    );
  }

  if (input.includeLinks && Array.isArray(input.links) && input.links.length > 0) {
    sections.push(
      [
        '## Links',
        ...input.links.map((link) => `- [${link.text || link.href}](${link.href})`),
      ].join('\n'),
    );
  }

  return collapseBlankLines(sections.join('\n\n')).trim();
}

/** Turn a title into a safe, readable file name stem. */
export function toFileNameStem(title: string, fallback = 'workflow-output'): string {
  const stem = String(title ?? '')
    .toLowerCase()
    // Anything that is not a word character becomes a separator, which also
    // removes path separators so a title cannot steer where a file is written.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return stem || fallback;
}
