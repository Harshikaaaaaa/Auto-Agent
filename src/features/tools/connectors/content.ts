import { ToolActionDefinition, ToolDefinition } from '../types';
import { registerTool } from '../toolRegistry';
import { extractFromHtml, toFileNameStem, toMarkdown } from '../content/htmlExtract';

const TOOL_ID = 'content';

/**
 * Content shaping: turn fetched HTML into readable text, and text into Markdown.
 *
 * These run locally with no credential and no network access, so they are always
 * available and cost nothing.
 */

const extractContent: ToolActionDefinition = {
  name: 'extract_content',
  description:
    'Pull the readable title, text, headings and links out of raw HTML, discarding navigation and scripts.',
  capabilities: ['content.extract'],
  sideEffect: 'read',
  requiresAuth: false,
  costProfile: { latencyMs: 20, cost: 0, reliability: 9 },
  inputSchema: {
    raw_content: {
      type: 'string',
      description: 'Raw HTML (or plain text) to extract from.',
      required: true,
    },
    final_url: {
      type: 'string',
      description: 'URL the content came from, used to make relative links absolute.',
      format: 'url',
    },
  },
  outputSchema: {
    title: { type: 'string', description: 'Page title, or the first heading.' },
    extracted_text: { type: 'string', description: 'Readable body text.' },
    headings: {
      type: 'array',
      description: 'Document outline.',
      items: { type: 'object', description: 'A heading with its level and text.' },
    },
    links: {
      type: 'array',
      description: 'Unique links found in the content.',
      items: { type: 'object', description: 'A link with its text and absolute href.' },
    },
  },
  execute: async (input) => {
    const html = input.raw_content ?? input.html ?? input.content ?? input.text ?? '';
    const baseUrl = input.final_url ?? input.source_url ?? undefined;

    const extracted = extractFromHtml(String(html), baseUrl ? String(baseUrl) : undefined);

    return {
      title: extracted.title,
      extracted_text: extracted.text,
      headings: extracted.headings,
      links: extracted.links,
    };
  },
};

const formatMarkdown: ToolActionDefinition = {
  name: 'to_markdown',
  description:
    'Compose a Markdown document from a title, body text, an outline, or tabular records.',
  capabilities: ['content.format'],
  sideEffect: 'read',
  requiresAuth: false,
  costProfile: { latencyMs: 10, cost: 0, reliability: 10 },
  inputSchema: {
    title: { type: 'string', description: 'Document heading.' },
    extracted_text: { type: 'string', description: 'Body text to include.' },
    headings: {
      type: 'array',
      description: 'Outline to render when there is no body text.',
      items: { type: 'object', description: 'A heading with its level and text.' },
    },
    records: {
      type: 'array',
      description: 'Rows to render as a Markdown table.',
      items: { type: 'object', description: 'One record; keys become columns.' },
    },
    final_url: { type: 'string', description: 'Source URL to cite.', format: 'url' },
    include_links: { type: 'boolean', description: 'Append a Links section.' },
  },
  outputSchema: {
    markdown: { type: 'string', description: 'The composed Markdown.', format: 'markdown' },
    suggested_filename: { type: 'string', description: 'A safe .md file name for the content.' },
  },
  execute: async (input) => {
    const title = input.title ?? input.heading ?? '';
    const text = input.extracted_text ?? input.text ?? input.summary ?? input.content ?? '';

    const markdown = toMarkdown({
      title: String(title),
      text: String(text),
      headings: Array.isArray(input.headings) ? input.headings : undefined,
      links: Array.isArray(input.links) ? input.links : undefined,
      records: Array.isArray(input.records)
        ? input.records
        : Array.isArray(input.categorized_results)
          ? input.categorized_results
          : undefined,
      sourceUrl: input.final_url ? String(input.final_url) : undefined,
      includeLinks: Boolean(input.include_links),
    });

    return {
      markdown,
      suggested_filename: `${toFileNameStem(String(title))}.md`,
    };
  },
};

const contentTool: ToolDefinition = {
  id: TOOL_ID,
  name: 'Content',
  description: 'Extract readable content from HTML and format it as Markdown.',
  icon: 'FileText',
  color: '#A78BFA',
  category: 'content',
  costProfile: { latencyMs: 20, cost: 0, reliability: 9 },
  scopes: [],
  actions: [extractContent, formatMarkdown],
  // Pure local transforms: nothing to authenticate.
  isAuthenticated: () => true,
  authenticate: async () => {},
  disconnect: () => {},
};

registerTool(contentTool);
