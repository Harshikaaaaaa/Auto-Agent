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
  inputSchema: {
    content: {
      type: 'string',
      description:
        'File content. Plain text for md/txt/csv/json/html, or base64 for a binary file (docx/pdf).',
      required: true,
    },
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
    // A binary artifact (docx/pdf) arrives base64-encoded under one of these
    // keys; a text file arrives as a plain string under content/markdown/etc.
    const binaryBase64 = input.docx_base64 ?? input.file_base64 ?? input.pdf_base64 ?? undefined;
    const content = input.content ?? input.markdown ?? input.text ?? input.result ?? '';
    const asString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    if (!binaryBase64 && !asString) {
      return {
        downloaded: false,
        saved_filename: '',
        bytes: 0,
        error: 'There was no content to download.',
      };
    }

    // Choose the file name (and thus extension) — a base64 payload defaults to
    // .docx when the name does not already say otherwise.
    const fileName = safeFileName(
      input.filename ?? input.suggested_filename ?? input.title,
      'workflow-output',
    );
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    const isBinary = BINARY_EXTENSIONS.has(extension) || Boolean(binaryBase64);

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
