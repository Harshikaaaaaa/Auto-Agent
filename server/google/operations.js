import { z } from 'zod';

/**
 * The complete set of Google calls the browser may ask the server to make.
 *
 * This is an ALLOWLIST OF NAMED OPERATIONS, not a URL proxy. A proxy that took a
 * URL from the browser and attached the user's token would be a confused deputy:
 * the caller could reach any endpoint the granted scopes allow, including ones
 * this product never intended to use, and the server would authorise it. Here the
 * browser names an operation and supplies validated parameters; the server builds
 * the URL.
 *
 * Each operation declares:
 *   toolId  which credential to use
 *   params  a zod schema; anything else in the body is dropped
 *   request (params) => { method, url, headers?, body? }
 *   parse   (payload) => the shape the connector expects
 */

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/** A1 notation, a sheet name, or a sheet-qualified range. */
const rangeSchema = z.string().min(1).max(200);
const spreadsheetIdSchema = z.string().min(1).max(200);
/** Cell values: rows of scalars. Objects are rejected — Sheets cannot take them. */
const valuesSchema = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(500))
  .min(1)
  .max(1000);

export const GOOGLE_OPERATIONS = {
  // ---------------------------------------------------------------- gmail

  gmail_send_message: {
    toolId: 'gmail',
    params: z.object({
      // base64url RFC-2822, assembled by the connector.
      raw: z.string().min(1).max(30_000_000),
    }),
    request: ({ raw }) => ({
      method: 'POST',
      url: `${GMAIL_BASE}/messages/send`,
      body: { raw },
    }),
    parse: (payload) => ({ id: payload.id ?? '', threadId: payload.threadId ?? '' }),
  },

  gmail_list_messages: {
    toolId: 'gmail',
    params: z.object({
      query: z.string().max(500).optional().default(''),
      maxResults: z.number().int().min(1).max(50).optional().default(5),
    }),
    request: ({ query, maxResults }) => {
      const search = new URLSearchParams({ maxResults: String(maxResults) });
      if (query) search.set('q', query);
      return { method: 'GET', url: `${GMAIL_BASE}/messages?${search.toString()}` };
    },
    parse: (payload) => ({
      messages: Array.isArray(payload.messages) ? payload.messages.map((m) => ({ id: m.id })) : [],
    }),
  },

  gmail_get_message: {
    toolId: 'gmail',
    params: z.object({
      id: z.string().min(1).max(200),
    }),
    request: ({ id }) => ({
      method: 'GET',
      // Metadata only: the product lists subjects and snippets, so there is
      // no reason to pull full message bodies through the server.
      url:
        `${GMAIL_BASE}/messages/${encodeURIComponent(id)}` +
        '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date',
    }),
    parse: (payload) => {
      const headers = payload.payload?.headers ?? [];
      const header = (name) => headers.find((h) => h.name === name)?.value ?? '';
      return {
        id: payload.id ?? '',
        subject: header('Subject'),
        from: header('From'),
        date: header('Date'),
        snippet: payload.snippet ?? '',
      };
    },
  },

  // --------------------------------------------------------------- sheets

  sheets_create_spreadsheet: {
    toolId: 'google_sheets',
    params: z.object({
      title: z.string().min(1).max(200),
    }),
    request: ({ title }) => ({
      method: 'POST',
      url: SHEETS_BASE,
      body: { properties: { title } },
    }),
    parse: (payload) => ({
      spreadsheetId: payload.spreadsheetId ?? '',
      spreadsheetUrl: payload.spreadsheetUrl ?? '',
    }),
  },

  sheets_get_values: {
    toolId: 'google_sheets',
    params: z.object({
      spreadsheetId: spreadsheetIdSchema,
      range: rangeSchema,
    }),
    request: ({ spreadsheetId, range }) => ({
      method: 'GET',
      url: `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    }),
    parse: (payload) => ({
      range: payload.range ?? '',
      values: Array.isArray(payload.values) ? payload.values : [],
    }),
  },

  sheets_update_values: {
    toolId: 'google_sheets',
    params: z.object({
      spreadsheetId: spreadsheetIdSchema,
      range: rangeSchema,
      values: valuesSchema,
    }),
    request: ({ spreadsheetId, range, values }) => ({
      method: 'PUT',
      url:
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
        '?valueInputOption=USER_ENTERED',
      body: { range, majorDimension: 'ROWS', values },
    }),
    parse: (payload) => ({
      updatedRange: payload.updatedRange ?? '',
      updatedRows: payload.updatedRows ?? 0,
      updatedCells: payload.updatedCells ?? 0,
    }),
  },

  sheets_append_values: {
    toolId: 'google_sheets',
    params: z.object({
      spreadsheetId: spreadsheetIdSchema,
      range: rangeSchema,
      values: valuesSchema,
    }),
    request: ({ spreadsheetId, range, values }) => ({
      method: 'POST',
      url:
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append` +
        '?valueInputOption=USER_ENTERED',
      body: { range, majorDimension: 'ROWS', values },
    }),
    parse: (payload) => ({
      updatedRange: payload.updates?.updatedRange ?? payload.updatedRange ?? '',
      updatedRows: payload.updates?.updatedRows ?? payload.updatedRows ?? 0,
      updatedCells: payload.updates?.updatedCells ?? payload.updatedCells ?? 0,
    }),
  },

  // ---------------------------------------------------------------- drive

  drive_list_files: {
    toolId: 'google_drive',
    params: z.object({
      query: z.string().max(500).optional().default(''),
      pageSize: z.number().int().min(1).max(100).optional().default(20),
    }),
    request: ({ query, pageSize }) => {
      const search = new URLSearchParams({
        pageSize: String(pageSize),
        fields: 'files(id,name,mimeType,modifiedTime,size)',
      });
      if (query) search.set('q', query);
      return { method: 'GET', url: `${DRIVE_BASE}/files?${search.toString()}` };
    },
    parse: (payload) => ({ files: Array.isArray(payload.files) ? payload.files : [] }),
  },

  drive_upload_file: {
    toolId: 'google_drive',
    params: z.object({
      name: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(120).optional().default('text/plain'),
      content: z.string().max(5_000_000),
    }),
    request: ({ name, mimeType, content }) => {
      // The multipart envelope is built here rather than in the browser, so
      // the boundary cannot be smuggled in through a filename.
      const boundary = `autoagent-${Math.random().toString(36).slice(2)}`;
      const safeMime = mimeType.replace(/[^\w.+/-]/g, '') || 'text/plain';
      const metadata = JSON.stringify({ name, mimeType: safeMime });
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${safeMime}\r\n\r\n${content}\r\n--${boundary}--`;

      return {
        method: 'POST',
        url: `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        rawBody: body,
      };
    },
    parse: (payload) => ({
      id: payload.id ?? '',
      name: payload.name ?? '',
      webViewLink: payload.webViewLink ?? '',
    }),
  },

  drive_download_file: {
    toolId: 'google_drive',
    params: z.object({
      fileId: z.string().min(1).max(200),
    }),
    request: ({ fileId }) => ({
      method: 'GET',
      url: `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      /** The response is file content, not JSON. */
      expects: 'text',
    }),
    parse: (payload) => ({ content: typeof payload === 'string' ? payload : '' }),
  },
};

export const GOOGLE_OPERATION_NAMES = Object.keys(GOOGLE_OPERATIONS);
