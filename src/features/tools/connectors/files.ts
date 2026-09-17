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
};

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
    content: { type: 'string', description: 'Text to put in the file.', required: true },
    filename: {
      type: 'string',
      description: 'Suggested file name. Sanitised, and limited to md, txt, csv, json or html.',
    },
  },
  outputSchema: {
    downloaded: { type: 'boolean', description: 'Whether the download was started.' },
    saved_filename: { type: 'string', description: 'File name that was offered.' },
    bytes: { type: 'number', description: 'Size of the file in bytes.' },
  },
  execute: async (input) => {
    const content = input.content ?? input.markdown ?? input.text ?? input.result ?? '';
    const asString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    if (!asString) {
      return {
        downloaded: false,
        saved_filename: '',
        bytes: 0,
        error: 'There was no content to download.',
      };
    }

    const fileName = safeFileName(input.filename ?? input.suggested_filename ?? input.title);
    const bytes = new TextEncoder().encode(asString).length;

    // A download needs a document to click through. In a non-browser context
    // (server-side rendering, tests) report honestly rather than pretending.
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return {
        downloaded: false,
        saved_filename: fileName,
        bytes,
        error: 'A file can only be downloaded from a browser.',
      };
    }

    const blob = new Blob([asString], { type: mimeTypeFor(fileName) });
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
