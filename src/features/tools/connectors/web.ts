import { apiUrl } from '@config/api';
import { ToolActionDefinition, ToolDefinition } from '../types';
import { registerTool } from '../toolRegistry';

const TOOL_ID = 'web';

/**
 * Web fetching.
 *
 * The request is made by the SERVER, not the browser, for two reasons: the
 * browser cannot read most cross-origin pages, and the server can enforce an
 * SSRF policy (see server/lib/ssrfGuard.js). This connector is a thin client
 * over `/api/fetch`.
 */

interface FetchResponse {
  status: number;
  contentType: string | null;
  body: string;
  bytes: number;
  finalUrl: string;
  redirects: string[];
}

interface FetchError {
  error?: string;
  reason?: string;
  message?: string;
}

const fetchPage: ToolActionDefinition = {
  name: 'fetch_page',
  description:
    'Fetch the contents of a public web page or API over http(s). Private and internal addresses are refused.',
  capabilities: ['web.fetch'],
  // Reads a remote resource; changes nothing.
  sideEffect: 'read',
  requiresAuth: false,
  costProfile: { latencyMs: 1500, cost: 0, reliability: 7 },
  inputSchema: {
    source_url: {
      type: 'string',
      description: 'Absolute http(s) URL to fetch.',
      required: true,
      external: true,
      format: 'url',
    },
    render_mode: {
      type: 'string',
      description:
        "How to handle JavaScript-heavy pages: 'auto' (default) renders with a headless browser only if the plain fetch returns an empty shell; 'always' always renders; 'never' never does. Requires server-side rendering to be enabled.",
    },
  },
  outputSchema: {
    raw_content: { type: 'string', description: 'Body of the response as text.' },
    content_type: { type: 'string', description: 'Content type the server reported.' },
    final_url: {
      type: 'string',
      description: 'URL after any redirects were followed.',
      format: 'url',
    },
    fetch_status: { type: 'number', description: 'HTTP status code.' },
  },
  execute: async (input) => {
    const target = input.source_url ?? input.url ?? input.input;

    if (!target || typeof target !== 'string') {
      return {
        raw_content: '',
        content_type: '',
        final_url: '',
        fetch_status: 0,
        error: 'No source_url was provided, so there is nothing to fetch.',
      };
    }

    // Rendering preference is optional and validated server-side; only pass a
    // recognised value so a stray input cannot make the request invalid.
    const renderMode = input.render_mode ?? input.render;
    const render =
      renderMode === 'always' || renderMode === 'never' || renderMode === 'auto'
        ? renderMode
        : undefined;

    const response = await fetch(apiUrl('/api/fetch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ url: target, ...(render ? { render } : {}) }),
    });

    if (!response.ok) {
      let detail: FetchError = {};
      try {
        detail = (await response.json()) as FetchError;
      } catch {
        // Non-JSON error body.
      }
      // Surface WHY it was refused: "blocked by policy" and "site is down" call
      // for very different fixes.
      return {
        raw_content: '',
        content_type: '',
        final_url: target,
        fetch_status: response.status,
        error: detail.message ?? `Could not fetch that URL (${response.status}).`,
      };
    }

    const result = (await response.json()) as FetchResponse;
    return {
      raw_content: result.body,
      content_type: result.contentType ?? '',
      final_url: result.finalUrl,
      fetch_status: result.status,
    };
  },
};

const webTool: ToolDefinition = {
  id: TOOL_ID,
  name: 'Web',
  description: 'Fetch public web pages and APIs through the server, with SSRF protection.',
  icon: 'Globe',
  color: '#38BDF8',
  category: 'web',
  costProfile: { latencyMs: 1500, cost: 0, reliability: 7 },
  scopes: [],
  actions: [fetchPage],
  // No credential to hold: the capability is always available.
  isAuthenticated: () => true,
  authenticate: async () => {},
  disconnect: () => {},
};

registerTool(webTool);
