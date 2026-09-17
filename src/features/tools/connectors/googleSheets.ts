import { Tool, ToolAction, ToolAuth } from '../types';
import { registerTool, saveToolAuth, loadToolAuth, clearToolAuth, silentRefreshGoogleToken } from '../toolRegistry';

const TOOL_ID = 'google_sheets';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const DEFAULT_SPREADSHEET_KEY = 'autoagent_google_sheets_default_id';

export function getDefaultSpreadsheetId(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(DEFAULT_SPREADSHEET_KEY);
}

async function getAccessToken(): Promise<string | null> {
    const auth = loadToolAuth(TOOL_ID);
    if (!auth) return null;
    if ((auth as any).expired) {
        const refreshed = await silentRefreshGoogleToken(TOOL_ID, SCOPES);
        if (!refreshed) return null;
        return loadToolAuth(TOOL_ID)?.accessToken || null;
    }
    return auth.accessToken;
}
function isAvailable(): boolean {
    return loadToolAuth(TOOL_ID) !== null;
}

async function sheetsApi(path: string, method = 'GET', body?: any): Promise<any> {
    const token = await getAccessToken();
    if (!token) throw new Error('Google Sheets not authenticated');
    const opts: RequestInit = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, opts);
    if (!res.ok) throw new Error(`Sheets API ${method} ${path}: ${res.status} — ${await res.text()}`);
    return res.json();
}

async function createDefaultSpreadsheet(accessToken: string): Promise<string | null> {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties: { title: 'AutoAgent Workflow Results' } })
    });

    if (!response.ok) {
        console.warn('[Google Sheets] Unable to create default spreadsheet:', await response.text());
        return null;
    }

    const spreadsheet = await response.json();
    const spreadsheetId = spreadsheet.spreadsheetId;
    if (spreadsheetId && typeof window !== 'undefined') {
        window.localStorage.setItem(DEFAULT_SPREADSHEET_KEY, spreadsheetId);
    }
    return spreadsheetId || null;
}

export async function ensureDefaultSpreadsheet(): Promise<string | null> {
    const existing = getDefaultSpreadsheetId();
    if (existing) return existing;

    const accessToken = await getAccessToken();
    if (!accessToken) return null;
    return createDefaultSpreadsheet(accessToken);
}

// ==================== ACTIONS ====================

const readSheet: ToolAction = {
    name: 'read_sheet',
    description: 'Read cells from a Google Sheets spreadsheet by range',
    inputKeys: ['spreadsheetId', 'range'],
    outputKeys: ['rows', 'rowCount'],
    execute: async (input) => {
        const id = input.spreadsheetId || input.spreadsheet_id || input.sheet_id || await ensureDefaultSpreadsheet();
        const range = input.range || 'Sheet1!A1:Z100';
        if (!id) return { error: 'Missing spreadsheetId' };
        const data = await sheetsApi(`${id}/values/${encodeURIComponent(range)}`);
        return { range: data.range, rows: data.values || [], rowCount: (data.values || []).length };
    }
};

const writeSheet: ToolAction = {
    name: 'write_sheet',
    description: 'Write data to a specific range in a Google Sheets spreadsheet',
    inputKeys: ['spreadsheetId', 'range', 'values'],
    outputKeys: ['updatedRange', 'updatedRows', 'updatedCells'],
    execute: async (input) => {
        const id = input.spreadsheetId || input.spreadsheet_id || await ensureDefaultSpreadsheet();
        const range = input.range || 'Sheet1!A1';
        const values = input.values || [['(empty)']];
        if (!id) return { error: 'Missing spreadsheetId' };
        const data = await sheetsApi(`${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, 'PUT', { range, majorDimension: 'ROWS', values });
        return { updatedRange: data.updatedRange, updatedRows: data.updatedRows, updatedCells: data.updatedCells };
    }
};

const appendRow: ToolAction = {
    name: 'append_row',
    description: 'Append a new row to the end of a Google Sheets spreadsheet',
    inputKeys: ['spreadsheetId', 'range', 'values'],
    outputKeys: ['updatedRange', 'updatedRows'],
    execute: async (input) => {
        const id = input.spreadsheetId || input.spreadsheet_id || await ensureDefaultSpreadsheet();
        const range = input.range || 'Sheet1';
        const row = input.values || input.row || ['(empty)'];
        if (!id) return { error: 'Missing spreadsheetId' };
        const values = Array.isArray(row[0]) ? row : [row];
        const data = await sheetsApi(`${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, 'POST', { range, majorDimension: 'ROWS', values });
        return { updatedRange: data.updatedRange, updatedRows: data.updatedRows, updatedCells: data.updatedCells };
    }
};

// ==================== TOOL DEFINITION ====================

const googleSheetsTool: Tool = {
    id: TOOL_ID,
    name: 'Google Sheets',
    description: 'Read, write, and append data in Google Sheets spreadsheets',
    icon: 'Sheet',
    color: '#34A853',
    scopes: SCOPES,
    actions: [readSheet, writeSheet, appendRow],
    isAuthenticated: isAvailable,
    authenticate: async () => {
        return new Promise<void>((resolve, reject) => {
            try {
                const google = (window as any).google;
                if (!google?.accounts?.oauth2) { reject(new Error('Google Identity Services not loaded')); return; }
                const client = google.accounts.oauth2.initTokenClient({
                    client_id: (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
                    scope: SCOPES.join(' '),
                    callback: (response: any) => {
                        if (response.error) { reject(new Error(response.error)); return; }
                        const auth: ToolAuth = { toolId: TOOL_ID, accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in * 1000), scopes: SCOPES };
                        saveToolAuth(auth);
                        void ensureDefaultSpreadsheet().finally(() => resolve());
                    }
                });
                client.requestAccessToken();
            } catch (err) { reject(err); }
        });
    },
    disconnect: () => {
        clearToolAuth(TOOL_ID);
        if (typeof window !== 'undefined') window.localStorage.removeItem(DEFAULT_SPREADSHEET_KEY);
    }
};

registerTool(googleSheetsTool);
