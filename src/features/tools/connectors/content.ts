import { ToolActionDefinition, ToolDefinition } from '../types';
import { registerTool } from '../toolRegistry';
import { extractFromHtml, toFileNameStem, toMarkdown } from '../content/htmlExtract';
import { buildDocxBase64 } from '../content/docx';

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
    // Declared so the engine passes them through: when a Summarize step runs
    // before this node, its output arrives under summary/result and must reach
    // the converter (it takes precedence over extracted_text below).
    summary: { type: 'string', description: 'A summary to use as the body, if present.' },
    result: {
      type: 'string',
      description: 'An upstream AI result to use as the body, if present.',
    },
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
    // A summary/result from an upstream AI step takes precedence over the raw
    // extracted text: if a Summarize node ran before this converter, the user
    // wants the SUMMARY in the document, not the full article. Only fall back to
    // extracted_text when no summary was produced (the plain scrape -> convert
    // flow). Without this, extracted_text always won and the summary was ignored.
    const text =
      input.summary ?? input.result ?? input.extracted_text ?? input.text ?? input.content ?? '';

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

const formatDocx: ToolActionDefinition = {
  name: 'to_docx',
  description:
    'Convert a title and body text (plain or Markdown) into a Microsoft Word .docx document, ready to download. Use when the user asks for a Word/DOCX file.',
  capabilities: ['content.format'],
  sideEffect: 'read',
  requiresAuth: false,
  costProfile: { latencyMs: 40, cost: 0, reliability: 9 },
  inputSchema: {
    title: { type: 'string', description: 'Document heading.' },
    extracted_text: {
      type: 'string',
      description: 'Body text (plain or Markdown) to put in the document.',
    },
    // See to_markdown: a Summarize step's output arrives here and takes
    // precedence over the raw extracted text.
    summary: { type: 'string', description: 'A summary to use as the body, if present.' },
    result: {
      type: 'string',
      description: 'An upstream AI result to use as the body, if present.',
    },
    markdown: { type: 'string', description: 'Markdown body, if produced upstream.' },
  },
  outputSchema: {
    // Base64 so the binary .docx travels through the string-typed graph state
    // and can be handed to the download node, which decodes it.
    docx_base64: { type: 'string', description: 'The .docx file, base64-encoded.' },
    file_base64: { type: 'string', description: 'Alias of docx_base64 for the download node.' },
    suggested_filename: { type: 'string', description: 'A safe .docx file name.' },
  },
  execute: async (input) => {
    const title = String(input.title ?? input.heading ?? '');
    // Prefer an upstream summary/result over the raw extracted text (see the
    // to_markdown note): a Summarize step's output must land in the .docx, not
    // the full article it summarised.
    const text = String(
      input.summary ??
        input.result ??
        input.extracted_text ??
        input.text ??
        input.markdown ??
        input.content ??
        '',
    );

    if (!title.trim() && !text.trim()) {
      return {
        docx_base64: '',
        file_base64: '',
        suggested_filename: '',
        error: 'There was no content to put in the document.',
      };
    }

    const base64 = await buildDocxBase64(title, text);
    const filename = `${toFileNameStem(title || 'workflow-output')}.docx`;
    // Expose under both keys so the download node picks it up whether it looks
    // for docx_base64 or the generic file_base64.
    return { docx_base64: base64, file_base64: base64, suggested_filename: filename };
  },
};

const contentTool: ToolDefinition = {
  id: TOOL_ID,
  name: 'Content',
  description: 'Extract readable content from HTML and format it as Markdown or a Word .docx.',
  icon: 'FileText',
  color: '#A78BFA',
  category: 'content',
  costProfile: { latencyMs: 20, cost: 0, reliability: 9 },
  scopes: [],
  actions: [extractContent, formatMarkdown, formatDocx],
  // Pure local transforms: nothing to authenticate.
  isAuthenticated: () => true,
  authenticate: async () => {},
  disconnect: () => {},
};

registerTool(contentTool);
