import { ToolActionDefinition, ToolDefinition } from '../types';
import { registerTool, saveToolAuth, loadToolAuth, clearToolAuth, silentRefreshGoogleToken } from '../toolRegistry';

const TOOL_ID = 'google_drive';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'];

function getAccessToken(): string | null {
    const auth = loadToolAuth(TOOL_ID);
    if (!auth) return null;
    if ((auth as any).expired) {
        silentRefreshGoogleToken(TOOL_ID, SCOPES);
        return auth.accessToken;
    }
    return auth.accessToken;
}
function isAvailable(): boolean {
    return loadToolAuth(TOOL_ID) !== null;
}

async function driveApi(path: string, method = 'GET', body?: any): Promise<any> {
    const token = getAccessToken();
    if (!token) throw new Error('Google Drive not authenticated');
    const opts: RequestInit = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, opts);
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
    return res.json();
}

// ==================== ACTIONS ====================

const listFiles: ToolActionDefinition = {
    name: 'list_files',
    description: 'List files in Google Drive, optionally filtered by a Drive query.',
    capabilities: ['file.list'],
    sideEffect: 'read',
    requiresAuth: true,
    costProfile: { latencyMs: 1000, cost: 0, reliability: 9 },
    inputSchema: {
        query: { type: 'string', description: 'Drive query, for example "name contains \'report\'".' },
        pageSize: { type: 'number', description: 'How many files to return.' }
    },
    outputSchema: {
        files: {
            type: 'array',
            description: 'Matching files.',
            items: { type: 'object', description: 'One file with id, name and mimeType.' }
        },
        count: { type: 'number', description: 'How many files were returned.' }
    },
    execute: async (input) => {
        const q = input.query ? `&q=${encodeURIComponent(input.query)}` : '';
        const size = input.pageSize || 20;
        const data = await driveApi(`files?pageSize=${size}&fields=files(id,name,mimeType,modifiedTime,size)${q}`);
        return { files: data.files || [], count: (data.files || []).length };
    }
};

const uploadFile: ToolActionDefinition = {
    name: 'upload_file',
    description: 'Upload text content as a new file in Google Drive.',
    capabilities: ['file.upload'],
    // Creates a new file rather than destroying one, and it can be deleted after.
    sideEffect: 'write',
    requiresAuth: true,
    costProfile: { latencyMs: 1400, cost: 0, reliability: 9 },
    inputSchema: {
        fileName: { type: 'string', description: 'Name to give the file.', required: true },
        content: { type: 'string', description: 'Text content of the file.', required: true },
        mimeType: {
            type: 'string',
            description: 'MIME type. Defaults to text/plain.',
            format: 'mime-type'
        }
    },
    outputSchema: {
        id: { type: 'string', description: 'Drive id of the created file.' },
        name: { type: 'string', description: 'Name of the created file.' },
        webViewLink: { type: 'string', description: 'Link to open the file.', format: 'url' }
    },
    execute: async (input) => {
        const token = getAccessToken();
        if (!token) throw new Error('Google Drive not authenticated');
        const name = input.fileName || input.file_name || 'untitled.txt';
        const content = input.content || '';
        const mime = input.mimeType || 'text/plain';
        const boundary = '===autoagent_boundary===';
        const metadata = JSON.stringify({ name, mimeType: mime });
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
        if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
        return await res.json();
    }
};

const downloadFile: ToolActionDefinition = {
    name: 'download_file',
    description: "Read a file's text content from Google Drive by its id.",
    capabilities: ['file.download'],
    sideEffect: 'read',
    requiresAuth: true,
    costProfile: { latencyMs: 1200, cost: 0, reliability: 9 },
    inputSchema: {
        fileId: { type: 'string', description: 'Drive id of the file.', required: true, external: true }
    },
    outputSchema: {
        content: { type: 'string', description: 'Text content of the file.' },
        length: { type: 'number', description: 'Length of the content in characters.' }
    },
    execute: async (input) => {
        const token = getAccessToken();
        if (!token) throw new Error('Google Drive not authenticated');
        const id = input.fileId || input.file_id;
        if (!id) return { error: 'Missing fileId' };
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`Drive download ${res.status}: ${await res.text()}`);
        const content = await res.text();
        return { fileId: id, content, length: content.length };
    }
};

// ==================== REGISTRATION ====================

const googleDriveTool: ToolDefinition = {
    id: TOOL_ID,
    name: 'Google Drive',
    description: 'List, upload, and download files in Google Drive.',
    icon: 'HardDrive',
    color: '#4285F4',
    category: 'storage',
    costProfile: { latencyMs: 1100, cost: 0, reliability: 9 },
    scopes: SCOPES,
    actions: [listFiles, uploadFile, downloadFile],
    isAuthenticated: isAvailable,
    authenticate: async () => {
        return new Promise<void>((resolve, reject) => {
            try {
                const google = (window as any).google;
                if (!google?.accounts?.oauth2) { reject(new Error('GIS not loaded')); return; }
                const client = google.accounts.oauth2.initTokenClient({
                    client_id: (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
                    scope: SCOPES.join(' '),
                    callback: (response: any) => {
                        if (response.error) { reject(new Error(response.error)); return; }
                        saveToolAuth({ toolId: TOOL_ID, accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in * 1000), scopes: SCOPES });
                        resolve();
                    }
                });
                client.requestAccessToken();
            } catch (err) { reject(err); }
        });
    },
    disconnect: () => { clearToolAuth(TOOL_ID); }
};

registerTool(googleDriveTool);
