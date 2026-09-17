import { ToolActionDefinition, ToolDefinition } from '../types';
import { isToolConnected, registerTool } from '../toolRegistry';
import { GoogleCallError, callGoogle, connectTool, disconnectTool } from '../googleClient';

/**
 * Google Drive.
 *
 * Every call goes through the server's Google proxy. This module holds no token,
 * reads no localStorage and never talks to googleapis.com. Before Task 13 it
 * built `Authorization: Bearer <token>` headers from a token in localStorage, and
 * its `getAccessToken` was synchronous — so when the token had expired it kicked
 * off a refresh and returned the STALE token anyway, producing a 401 the caller
 * had to interpret.
 */

const TOOL_ID = 'google_drive';
/** Declared for the UI and the catalog. The server owns what is requested. */
const SCOPES = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file'
];

/** Turn a proxy failure into the `error` output the engine reads. */
function asFailure(err: unknown): Record<string, unknown> {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
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
        try {
            const { files } = await callGoogle<{ files: unknown[] }>('drive_list_files', {
                query: input.query ? String(input.query) : '',
                pageSize: Number(input.pageSize) || 20
            });
            return { files, count: files.length };
        } catch (err) {
            return asFailure(err);
        }
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
        const name = String(input.fileName || input.file_name || 'untitled.txt');
        const content = input.content === undefined ? '' : String(input.content);

        try {
            // The multipart envelope is assembled server side, so a crafted
            // filename cannot break out of the boundary.
            return await callGoogle('drive_upload_file', {
                name,
                content,
                mimeType: String(input.mimeType || 'text/plain')
            });
        } catch (err) {
            return asFailure(err);
        }
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
        const fileId = input.fileId || input.file_id;
        if (!fileId) return { error: 'Missing fileId — no file was named to download.' };

        try {
            const { content } = await callGoogle<{ content: string }>('drive_download_file', {
                fileId: String(fileId)
            });
            return { fileId, content, length: content.length };
        } catch (err) {
            return asFailure(err);
        }
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
    isAuthenticated: () => isToolConnected(TOOL_ID),
    authenticate: () => connectTool(TOOL_ID),
    disconnect: () => {
        void disconnectTool(TOOL_ID).catch((err: GoogleCallError) =>
            console.warn(`[${TOOL_ID}] disconnect failed:`, err.message)
        );
    }
};

registerTool(googleDriveTool);
