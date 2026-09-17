import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupWorkflowRoutes } from './workflowHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3234;

app.use(cors());
app.use(express.json());

// Setup workflow routes
setupWorkflowRoutes(app);

let sock;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let lastDisconnectReason = null;

// Ensure auth directory exists
const AUTH_DIR = path.join(__dirname, '.wa-auth');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Simple in-memory store for recent incoming messages demonstration
const recentMessages = [];

async function startServer() {
    // Shared state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const startSock = async () => {
        sock = makeWASocket({  // Removed .default as per successful import logic
            auth: state,
            syncFullHistory: false, // keep it light
            // implement a basic msg retry handler if needed
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                QRCode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        qrCodeData = url;
                        connectionStatus = 'scan_qr';
                    }
                });
                QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
                    if (!err) console.log(url);
                });
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed, reconnect:', shouldReconnect);
                connectionStatus = 'disconnected';
                lastDisconnectReason = lastDisconnect?.error?.message;

                if (shouldReconnect) {
                    setTimeout(startSock, 2000);
                } else {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    setTimeout(startSock, 1000);
                }
            } else if (connection === 'open') {
                console.log('WhatsApp Connected!');
                connectionStatus = 'connected';
                qrCodeData = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Simple message listener to populate a volatile 'recentMessages' list for testing
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.message) continue;
                    // Extract text
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const from = msg.key.remoteJid;
                    const pushName = msg.pushName;

                    recentMessages.unshift({
                        id: msg.key.id,
                        from,
                        pushName,
                        text,
                        timestamp: msg.messageTimestamp,
                        fromMe: msg.key.fromMe
                    });

                    // Keep list small
                    if (recentMessages.length > 50) recentMessages.pop();
                }
            }
        });
    };

    await startSock();

    // Endpoints
    app.get('/status', (req, res) => res.json({
        status: connectionStatus,
        user: sock?.user,
        lastDisconnectReason,
        qrAvailable: !!qrCodeData,
        qrUrl: qrCodeData ? '/qr' : null
    }));

    app.get('/qr', (req, res) => {
        if (connectionStatus === 'connected') {
            if (req.accepts('html')) {
                return res.send(`
                    <html lang="en">
                        <head>
                            <meta charset="UTF-8" />
                            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                            <title>WhatsApp QR Code</title>
                            <style>
                                body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                                .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
                                .status { margin-bottom: 18px; color: #34d399; font-weight: 700; }
                                .hint { color: #cbd5e1; margin-top: 14px; font-size: 0.95rem; }
                                .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
                            </style>
                        </head>
                        <body>
                            <div class="card">
                                <div class="status">WhatsApp already connected</div>
                                <div class="hint">If you want to switch devices, logout or disconnect from the API and scan again.</div>
                                <a class="refresh" href="/qr">Refresh status</a>
                            </div>
                        </body>
                    </html>
                `);
            }
            return res.status(400).json({ error: 'Connected' });
        }

        if (!qrCodeData) {
            if (req.accepts('html')) {
                return res.send(`
                    <html lang="en">
                        <head>
                            <meta charset="UTF-8" />
                            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                            <title>WhatsApp QR Code</title>
                            <style>
                                body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                                .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
                                .status { margin-bottom: 18px; color: #fbbf24; font-weight: 700; }
                                .hint { color: #cbd5e1; margin-top: 14px; font-size: 0.95rem; }
                                .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
                            </style>
                        </head>
                        <body>
                            <div class="card">
                                <div class="status">Waiting for QR code...</div>
                                <div class="hint">The bridge is initializing. Reload this page after a moment.</div>
                                <a class="refresh" href="/qr">Refresh</a>
                            </div>
                        </body>
                    </html>
                `);
            }
            return res.status(503).json({ error: 'Generating QR...' });
        }

        if (req.accepts('html')) {
            return res.send(`
                <html lang="en">
                    <head>
                        <meta charset="UTF-8" />
                        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                        <title>WhatsApp QR Code</title>
                        <style>
                            body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                            .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
                            .title { font-size: 1.2rem; font-weight: 700; margin-bottom: 20px; }
                            .hint { color: #cbd5e1; margin-top: 16px; font-size: 0.95rem; }
                            .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
                            img { max-width: 100%; height: auto; border-radius: 20px; background: #fff; padding: 16px; }
                            .footer { margin-top: 18px; color: #94a3b8; font-size: 0.9rem; }
                        </style>
                    </head>
                    <body>
                        <div class="card">
                            <div class="title">Scan this QR code with WhatsApp</div>
                            <img src="${qrCodeData}" alt="WhatsApp QR Code" />
                            <div class="hint">Open WhatsApp → Linked Devices → Link a Device → Scan QR.</div>
                            <div class="footer">Reload if the code expires.</div>
                            <a class="refresh" href="/qr">Refresh</a>
                        </div>
                    </body>
                </html>
            `);
        }

        res.json({ qr: qrCodeData });
    });

    app.post('/send', async (req, res) => {
        if (connectionStatus !== 'connected') return res.status(503).json({ error: 'Not connected' });
        const { to, text, mediaUrl, mediaType } = req.body;

        // Require 'to' and at least 'text' OR 'mediaUrl'
        if (!to || (!text && !mediaUrl)) return res.status(400).json({ error: 'Missing to/text/mediaUrl' });

        try {
            const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

            if (mediaUrl) {
                // Normalize mediaType: "image/jpg" -> "image", "video/mp4" -> "video", etc.
                let rawType = (mediaType || 'image').toString().toLowerCase().trim();
                if (rawType.includes('/')) rawType = rawType.split('/')[0];
                // Map to Baileys-supported keys
                const typeMap = { image: 'image', video: 'video', audio: 'audio', document: 'document' };
                const type = typeMap[rawType] || 'image';

                console.log(`[WhatsApp] Sending media — type: ${type}, url: ${mediaUrl}`);

                // Determine media source: local file or URL
                const trimmedUrl = mediaUrl.trim();
                let mediaSource;
                if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
                    mediaSource = { url: trimmedUrl };
                } else {
                    // Local file path — read into buffer
                    const fs = require('fs');
                    const path = require('path');
                    const resolvedPath = path.resolve(trimmedUrl);
                    if (!fs.existsSync(resolvedPath)) {
                        return res.status(400).json({ error: `File not found: ${resolvedPath}` });
                    }
                    mediaSource = fs.readFileSync(resolvedPath);
                }

                const content = {
                    [type]: mediaSource,
                    caption: text || ''
                };
                await sock.sendMessage(jid, content);
            } else {
                // Send text only
                await sock.sendMessage(jid, { text });
            }

            res.json({ success: true, to: jid });
        } catch (e) {
            console.error('Send failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/messages', (req, res) => {
        // Return in-memory recent messages
        // Optional filter: ?jid=...
        const { jid } = req.query;
        let msgs = recentMessages;
        if (jid) {
            msgs = msgs.filter(m => m.from === jid || (m.fromMe && jid === sock?.user?.id)); // loose filter
        }
        res.json({ messages: msgs.slice(0, 20) });
    });

    app.post('/disconnect', async (req, res) => {
        try {
            await sock.logout();
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            res.json({ success: true });
            // The connection.close handler will likely restart the socket logic to generate a new QR
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.listen(PORT, () => {
        console.log(`WhatsApp Bridge Server running on http://localhost:${PORT}`);
    });
}

startServer();
