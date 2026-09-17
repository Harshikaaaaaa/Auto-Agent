import { ToolActionDefinition, ToolDefinition } from '../types';
import { isToolConnected, registerTool } from '../toolRegistry';
import { GoogleCallError, callGoogle, connectTool, disconnectTool } from '../googleClient';

/**
 * Google Sheets.
 *
 * Every call goes through the server's Google proxy; this module holds no token.
 *
 * One behaviour deliberately removed: connecting Sheets used to CREATE a
 * spreadsheet as a side effect, and every action silently fell back to that
 * spreadsheet when no id was supplied. So a workflow that never named a
 * destination wrote to a file the user did not know existed. A missing
 * spreadsheet id is now reported — the plan preview asks for it up front, because
 * `spreadsheetId` is declared `external`.
 */

const TOOL_ID = 'google_sheets';
/** Declared for the UI and the catalog. The server owns what is requested. */
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const MISSING_ID =
  'No spreadsheetId was supplied. Paste the id from the spreadsheet URL into this step.';

function asFailure(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return { error: message };
}

/** Cell values as Sheets accepts them: rows of scalars. */
function toRows(value: unknown): (string | number | boolean | null)[][] {
  const scalar = (cell: unknown): string | number | boolean | null => {
    if (cell === null || cell === undefined) return null;
    if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'string') {
      return cell;
    }
    // An object in a cell would serialise as "[object Object]" upstream.
    return JSON.stringify(cell);
  };

  if (!Array.isArray(value)) return [[scalar(value)]];
  if (value.length === 0) return [[null]];
  if (Array.isArray(value[0])) return (value as unknown[][]).map((row) => row.map(scalar));
  return [value.map(scalar)];
}

function spreadsheetIdFrom(input: Record<string, unknown>): string {
  return String(input.spreadsheetId || input.spreadsheet_id || input.sheet_id || '').trim();
}

// ==================== ACTIONS ====================

const readSheet: ToolActionDefinition = {
  name: 'read_sheet',
  description: 'Read cell values from a range of a Google Sheets spreadsheet.',
  capabilities: ['spreadsheet.read'],
  sideEffect: 'read',
  requiresAuth: true,
  costProfile: { latencyMs: 800, cost: 0, reliability: 9 },
  inputSchema: {
    spreadsheetId: {
      type: 'string',
      description: 'Id of the spreadsheet, from its URL.',
      required: true,
      external: true,
    },
    range: { type: 'string', description: 'A1 range, for example "Sheet1!A1:D50".' },
  },
  outputSchema: {
    range: { type: 'string', description: 'Range that was read.' },
    rows: {
      type: 'array',
      description: 'Rows that were read.',
      items: { type: 'array', description: 'One row of cell values.' },
    },
    rowCount: { type: 'number', description: 'How many rows were read.' },
  },
  execute: async (input) => {
    const spreadsheetId = spreadsheetIdFrom(input);
    if (!spreadsheetId) return { error: MISSING_ID };

    try {
      const result = await callGoogle<{ range: string; values: unknown[][] }>('sheets_get_values', {
        spreadsheetId,
        range: String(input.range || 'Sheet1!A1:Z100'),
      });
      return {
        range: result.range,
        rows: result.values,
        rowCount: result.values.length,
      };
    } catch (err) {
      return asFailure(err);
    }
  },
};

const writeSheet: ToolActionDefinition = {
  name: 'write_sheet',
  description:
    'Overwrite a range of a Google Sheets spreadsheet with new values. Replaces whatever was there.',
  capabilities: ['spreadsheet.write'],
  // Overwrites existing cells, but a spreadsheet can be corrected afterwards.
  sideEffect: 'write',
  requiresAuth: true,
  costProfile: { latencyMs: 900, cost: 0, reliability: 9 },
  inputSchema: {
    spreadsheetId: {
      type: 'string',
      description: 'Id of the spreadsheet, from its URL.',
      required: true,
      external: true,
    },
    range: { type: 'string', description: 'A1 range to overwrite.', required: true },
    values: {
      type: 'array',
      description: 'Rows to write.',
      required: true,
      items: { type: 'array', description: 'One row of cell values.' },
    },
  },
  outputSchema: {
    updatedRange: { type: 'string', description: 'Range that was written.' },
    updatedRows: { type: 'number', description: 'How many rows changed.' },
    updatedCells: { type: 'number', description: 'How many cells changed.' },
  },
  execute: async (input) => {
    const spreadsheetId = spreadsheetIdFrom(input);
    if (!spreadsheetId) return { error: MISSING_ID };

    try {
      return await callGoogle('sheets_update_values', {
        spreadsheetId,
        range: String(input.range || 'Sheet1!A1'),
        values: toRows(input.values),
      });
    } catch (err) {
      return asFailure(err);
    }
  },
};

const appendRow: ToolActionDefinition = {
  name: 'append_row',
  description:
    'Append rows to the end of a Google Sheets spreadsheet without overwriting anything.',
  capabilities: ['spreadsheet.write'],
  sideEffect: 'write',
  requiresAuth: true,
  costProfile: { latencyMs: 900, cost: 0, reliability: 9 },
  inputSchema: {
    spreadsheetId: {
      type: 'string',
      description: 'Id of the spreadsheet, from its URL.',
      required: true,
      external: true,
    },
    range: { type: 'string', description: 'Sheet or range to append into.' },
    values: {
      type: 'array',
      description: 'Rows to append.',
      required: true,
      items: { type: 'array', description: 'One row of cell values.' },
    },
  },
  outputSchema: {
    updatedRange: { type: 'string', description: 'Range that received the rows.' },
    updatedRows: { type: 'number', description: 'How many rows were appended.' },
    updatedCells: { type: 'number', description: 'How many cells were written.' },
  },
  execute: async (input) => {
    const spreadsheetId = spreadsheetIdFrom(input);
    if (!spreadsheetId) return { error: MISSING_ID };

    try {
      return await callGoogle('sheets_append_values', {
        spreadsheetId,
        range: String(input.range || 'Sheet1'),
        values: toRows(input.values ?? input.row),
      });
    } catch (err) {
      return asFailure(err);
    }
  },
};

// ==================== TOOL DEFINITION ====================

const googleSheetsTool: ToolDefinition = {
  category: 'spreadsheet',
  costProfile: { latencyMs: 900, cost: 0, reliability: 9 },
  id: TOOL_ID,
  name: 'Google Sheets',
  description: 'Read, write, and append data in Google Sheets spreadsheets',
  icon: 'Sheet',
  color: '#34A853',
  scopes: SCOPES,
  actions: [readSheet, writeSheet, appendRow],
  isAuthenticated: () => isToolConnected(TOOL_ID),
  authenticate: () => connectTool(TOOL_ID),
  disconnect: () => {
    void disconnectTool(TOOL_ID).catch((err: GoogleCallError) =>
      console.warn(`[${TOOL_ID}] disconnect failed:`, err.message),
    );
  },
};

registerTool(googleSheetsTool);
