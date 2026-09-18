import { ToolActionDefinition, ToolDefinition } from '../types';
import { registerTool } from '../toolRegistry';
import { toFileNameStem } from '../content/htmlExtract';

const TOOL_ID = 'files';

/** Extensions this node will produce, mapped to their content type. */
const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

/** Extensions delivered as BINARY (their content arrives base64-encoded). */
const BINARY_EXTENSIONS = new Set(['docx', 'pdf']);

/**
 * Guess the file extension a download node intends from its label, e.g.
 * "Download DOCX File" -> "docx", "Download Markdown File" -> "md". Used only as
 * a hint when the node has no explicit filename/format, to tell two parallel
 * download branches apart. Returns undefined when the label says nothing.
 */
function detectExtensionFromLabel(label: string): string | undefined {
  const text = label.toLowerCase();
  if (text.includes('docx') || text.includes('word')) return 'docx';
  if (text.includes('pdf')) return 'pdf';
  if (text.includes('markdown') || /\bmd\b/.test(text)) return 'md';
  if (text.includes('csv')) return 'csv';
  if (text.includes('json')) return 'json';
  if (text.includes('html')) return 'html';
  return undefined;
}

/** Decode a base64 string to bytes, in the browser or a test environment. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Force a file name to be a plain name with a known extension.
 *
 * The name can come from model output or fetched page content, so it is rebuilt
 * from a sanitised stem rather than trusted: a value like `../../.env` must not
 * be able to influence where the browser writes.
 */
export function safeFileName(rawName: unknown, fallbackStem = 'workflow-output'): string {
  const asString = String(rawName ?? '').trim();
  // Take the last path segment, then strip anything that is not a file name.
  const lastSegment = asString.split(/[\\/]/).pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');

  const rawStem = dotIndex > 0 ? lastSegment.slice(0, dotIndex) : lastSegment;
  const rawExtension = dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : '';

  const stem = toFileNameStem(rawStem, fallbackStem);
  const extension = MIME_BY_EXTENSION[rawExtension] ? rawExtension : 'md';

  return `${stem}.${extension}`;
}

/** Content type for a file name, defaulting to plain text. */
export function mimeTypeFor(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'text/plain';
}

const downloadFile: ToolActionDefinition = {
  name: 'download_file',
  description:
    'Deliver text content to the user as a downloadable file in their browser. Use this as the final step when the user asked to download something.',
  capabilities: ['file.deliver'],
  // Writes nothing anywhere the workflow controls; it hands a file to the user.
  sideEffect: 'read',
  requiresAuth: false,
  costProfile: { latencyMs: 10, cost: 0, reliability: 10 },
  // The executor passes a node ONLY its declared input keys from graph state, so
  // every key an upstream step might place the content under must be declared
  // here — otherwise it is sliced out before this action runs and the file comes
  // out empty. `markdown` (to_markdown), `docx_base64`/`file_base64` (to_docx)
  // and the generic text aliases are all accepted.
  inputSchema: {
    content: {
      type: 'string',
      description:
        'File content. Plain text for md/txt/csv/json/html, or base64 for a binary file (docx/pdf). May instead arrive under markdown/text/docx_base64/file_base64.',
    },
    markdown: { type: 'string', description: 'Markdown content (from a to_markdown step).' },
    text: { type: 'string', description: 'Plain text content.' },
    result: { type: 'string', description: 'Generic upstream result to write.' },
    docx_base64: { type: 'string', description: 'Base64 .docx (from a to_docx step).' },
    file_base64: { type: 'string', description: 'Base64 binary file content.' },
    pdf_base64: { type: 'string', description: 'Base64 .pdf content.' },
    suggested_filename: { type: 'string', description: 'File name proposed by an upstream step.' },
    title: { type: 'string', description: 'Used to derive a file name when none is given.' },
    filename: {
      type: 'string',
      description:
        'Suggested file name. Sanitised, and limited to md, txt, csv, json, html, docx or pdf.',
    },
  },
  outputSchema: {
    downloaded: { type: 'boolean', description: 'Whether the download was started.' },
    saved_filename: { type: 'string', description: 'File name that was offered.' },
    bytes: { type: 'number', description: 'Size of the file in bytes.' },
  },
  execute: async (input) => {
    // The REQUESTED format decides what to deliver — never "whatever base64
    // happens to be in state". With parallel branches (a Markdown download and
    // a DOCX download) both `markdown` and `docx_base64` are present in the
    // merged state, so a node that guessed from state delivered a .docx for
    // BOTH. The node's own filename/format is authoritative instead.
    //
    // Resolve the intended extension first, WITHOUT letting a stray base64
    // payload flip it. An explicit `filename`/`format` on the node wins; a
    // docx-branch `suggested_filename` (…\.docx) or markdown one (…\.md) is used
    // only when the node itself did not say.
    const explicitName = input.filename ?? input.format;
    // The node's label ("Download DOCX File", "Download Markdown File") is a
    // reliable branch hint when no explicit filename/format is configured, and
    // it flows into the input as `label`. This is what disambiguates the two
    // parallel downloads when they share the merged state.
    const labelHint = detectExtensionFromLabel(String(input.label ?? ''));
    const requestedExtension =
      String(explicitName ?? '')
        .split('.')
        .pop()
        ?.toLowerCase() || labelHint;
    const wantsBinary = requestedExtension
      ? BINARY_EXTENSIONS.has(requestedExtension)
      : // Nothing said which format: fall back to whichever content exists,
        // preferring text so a co-present docx_base64 does not hijack a plain
        // download.
        !(input.content ?? input.markdown ?? input.text ?? input.result);

    const binaryBase64 = wantsBinary
      ? (input.docx_base64 ?? input.file_base64 ?? input.pdf_base64 ?? undefined)
      : undefined;
    const content = wantsBinary
      ? ''
      : (input.content ?? input.markdown ?? input.text ?? input.result ?? '');
    const asString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    if (!binaryBase64 && !asString) {
      return {
        downloaded: false,
        saved_filename: '',
        bytes: 0,
        error: 'There was no content to download.',
      };
    }

    // Build the file name. Prefer the node's own name; only accept an upstream
    // suggested_filename whose extension matches what we are actually delivering
    // (so a docx branch's suggestion cannot rename a markdown download).
    const upstreamName = input.suggested_filename;
    const upstreamExt = String(upstreamName ?? '')
      .split('.')
      .pop()
      ?.toLowerCase();
    const upstreamMatches =
      upstreamExt && BINARY_EXTENSIONS.has(upstreamExt) === wantsBinary ? upstreamName : undefined;
    const targetExt = requestedExtension ?? (wantsBinary ? 'docx' : 'md');
    // Derive a clean stem from the best available name, then FORCE the target
    // extension so a markdown branch is always .md and a docx branch always
    // .docx, regardless of what extension a co-present suggested_filename had.
    const nameSource = String(explicitName ?? upstreamMatches ?? input.title ?? 'workflow-output');
    const stem = toFileNameStem(nameSource.replace(/\.[a-z0-9]+$/i, ''));
    const fileName = safeFileName(`${stem}.${targetExt}`);
    const isBinary = wantsBinary && Boolean(binaryBase64);

    // A download needs a document to click through. In a non-browser context
    // (server-side rendering, tests) report honestly rather than pretending.
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return {
        downloaded: false,
        saved_filename: fileName,
        bytes: isBinary && binaryBase64 ? base64ToBytes(String(binaryBase64)).length : 0,
        error: 'A file can only be downloaded from a browser.',
      };
    }

    let blob: Blob;
    let bytes: number;
    if (isBinary && binaryBase64) {
      const data = base64ToBytes(String(binaryBase64));
      bytes = data.length;
      blob = new Blob([data], { type: mimeTypeFor(fileName) });
    } else {
      bytes = new TextEncoder().encode(asString).length;
      blob = new Blob([asString], { type: mimeTypeFor(fileName) });
    }
    const objectUrl = URL.createObjectURL(blob);

    try {
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      // Always release the blob, even if the click throws, or the page holds the
      // whole file in memory until reload.
      URL.revokeObjectURL(objectUrl);
    }

    return { downloaded: true, saved_filename: fileName, bytes };
  },
};

const filesTool: ToolDefinition = {
  id: TOOL_ID,
  name: 'Files',
  description: 'Deliver generated content to the user as a downloadable file.',
  icon: 'Download',
  color: '#F59E0B',
  category: 'files',
  costProfile: { latencyMs: 10, cost: 0, reliability: 10 },
  scopes: [],
  actions: [downloadFile],
  isAuthenticated: () => true,
  authenticate: async () => {},
  disconnect: () => {},
};

registerTool(filesTool);
