import { Tool, ToolAction, ToolAuth } from '../types';
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

const listFiles: ToolAction = {
    name: 'list_files',
    description: 'List files in Google Drive, optionally filtered by query',
    inputKeys: ['query', 'pageSize'],
    outputKeys: ['files', 'count'],
    execute: async (input) => {
        const q = input.query ? `&q=${encodeURIComponent(input.query)}` : '';
        const size = input.pageSize || 20;
        const data = await driveApi(`files?pageSize=${size}&fields=files(id,name,mimeType,modifiedTime,size)${q}`);
        return { files: data.files || [], count: (data.files || []).length };
    }
};

const uploadFile: ToolAction = {
    name: 'upload_file',
    description: 'Upload text content as a file to Google Drive',
    inputKeys: ['fileName', 'content', 'mimeType'],
    outputKeys: ['id', 'name', 'webViewLink'],
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

const downloadFile: ToolAction = {
    name: 'download_file',
    description: "Download a file's text content from Google Drive by file ID",
    inputKeys: ['fileId'],
    outputKeys: ['content', 'length'],
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

const googleDriveTool: Tool = {
    id: TOOL_ID,
    name: 'Google Drive',
    description: 'List, upload, and download files from Google Drive',
    icon: 'HardDrive',
    color: '#4285F4',
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
